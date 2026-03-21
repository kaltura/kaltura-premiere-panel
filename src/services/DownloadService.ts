import { KalturaClient } from "./KalturaClient";
import { KalturaFlavorAsset } from "../types/kaltura";
import { AssetMapping, ImportResult } from "../types/premiere";
import { MediaService } from "./MediaService";
import { NetworkError } from "../utils/errors";
import { MAX_CONCURRENT_DOWNLOADS } from "../utils/constants";
import { createLogger } from "../utils/logger";

/** Minimal host interface needed by DownloadService */
interface DownloadHostService {
  importFile(filePath: string): Promise<ImportResult>;
  isImported(entryId: string): boolean;
  storeMapping(entryId: string, localPath: string): void;
}

const log = createLogger("DownloadService");

const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/bmp": "bmp",
  "image/tiff": "tif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/x-adobe-dng": "dng",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/x-msvideo": "avi",
  "video/x-matroska": "mkv",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/aac": "aac",
  "audio/flac": "flac",
  "application/pdf": "pdf",
};

/** Detect the correct file extension from Content-Type or magic bytes */
function detectFileExtension(contentType: string | null, data: Uint8Array): string | null {
  // Try Content-Type header first
  if (contentType) {
    const mime = contentType.split(";")[0].trim().toLowerCase();
    if (MIME_TO_EXT[mime]) return MIME_TO_EXT[mime];
  }
  // Fall back to magic bytes
  if (data.length >= 4) {
    // PNG: 89 50 4E 47
    if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return "png";
    // JPEG: FF D8 FF
    if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "jpg";
    // GIF: 47 49 46
    if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return "gif";
    // BMP: 42 4D
    if (data[0] === 0x42 && data[1] === 0x4d) return "bmp";
    // WEBP: RIFF....WEBP
    if (
      data[0] === 0x52 &&
      data[1] === 0x49 &&
      data[2] === 0x46 &&
      data[3] === 0x46 &&
      data.length >= 12 &&
      data[8] === 0x57 &&
      data[9] === 0x45 &&
      data[10] === 0x42 &&
      data[11] === 0x50
    )
      return "webp";
  }
  return null;
}

export interface DownloadProgress {
  entryId: string;
  loaded: number;
  total: number;
  percent: number;
  speed: number;
}

export interface DownloadRequest {
  entryId: string;
  flavorId: string;
  fileName: string;
}

interface ActiveDownload {
  request: DownloadRequest;
  controller: AbortController;
  startTime: number;
}

/**
 * Manages downloading Kaltura assets and importing them into Premiere.
 * Supports concurrent download limiting and progress tracking.
 */
export class DownloadService {
  private activeDownloads = new Map<string, ActiveDownload>();
  private downloadQueue: DownloadRequest[] = [];
  private onProgressCallbacks = new Map<string, (progress: DownloadProgress) => void>();

  constructor(
    private client: KalturaClient,
    private mediaService: MediaService,
    private hostService: DownloadHostService,
  ) {}

  /** Get the number of active downloads */
  get activeCount(): number {
    return this.activeDownloads.size;
  }

  /** Get the download queue length */
  get queueLength(): number {
    return this.downloadQueue.length;
  }

  /**
   * Download and import an entry directly (no flavor required).
   * Used for image and document entries that have no flavor assets.
   * Uses raw CDN URL (no redirects, avoids UXP "Already read" bug).
   */
  async downloadAndImportEntry(
    entryId: string,
    entryName: string,
    onProgress?: (progress: DownloadProgress) => void,
  ): Promise<AssetMapping> {
    // Extract file extension from entry name, validate it's a known media format
    const KNOWN_EXTENSIONS = new Set([
      "jpg",
      "jpeg",
      "png",
      "gif",
      "bmp",
      "tiff",
      "tif",
      "webp",
      "svg",
      "psd",
      "mp4",
      "mov",
      "avi",
      "mkv",
      "wmv",
      "flv",
      "webm",
      "mxf",
      "mpg",
      "mpeg",
      "mp3",
      "wav",
      "aac",
      "flac",
      "ogg",
      "wma",
      "aiff",
      "aif",
      "m4a",
    ]);
    const dotIdx = entryName.lastIndexOf(".");
    const rawExt = dotIdx > 0 ? entryName.slice(dotIdx + 1).toLowerCase() : "";
    const fileExt = KNOWN_EXTENSIONS.has(rawExt) ? rawExt : "jpg";
    const fileName = `${entryId}_source.${fileExt}`;
    const request: DownloadRequest = {
      entryId,
      flavorId: "source",
      fileName,
    };

    if (onProgress) {
      this.onProgressCallbacks.set(entryId, onProgress);
    }

    if (this.activeDownloads.size >= MAX_CONCURRENT_DOWNLOADS) {
      log.info("Download queued (direct)", {
        entryId,
        queuePosition: this.downloadQueue.length + 1,
      });
      this.downloadQueue.push(request);
      return new Promise((resolve, reject) => {
        const check = setInterval(async () => {
          if (this.activeDownloads.has(entryId)) {
            clearInterval(check);
          }
          const idx = this.downloadQueue.indexOf(request);
          if (idx === -1 && !this.activeDownloads.has(entryId)) {
            clearInterval(check);
            try {
              const result = await this.executeDirectDownload(request);
              resolve(result);
            } catch (err) {
              reject(err);
            }
          }
        }, 500);
      });
    }

    return this.executeDirectDownload(request);
  }

  /**
   * Download and import a Kaltura asset into Premiere.
   * Returns the local file path of the downloaded asset.
   */
  async downloadAndImport(
    entryId: string,
    flavor: KalturaFlavorAsset,
    onProgress?: (progress: DownloadProgress) => void,
  ): Promise<AssetMapping> {
    const fileName = `${entryId}_${flavor.id}.${flavor.fileExt || "mp4"}`;
    const request: DownloadRequest = { entryId, flavorId: flavor.id, fileName };

    if (onProgress) {
      this.onProgressCallbacks.set(entryId, onProgress);
    }

    if (this.activeDownloads.size >= MAX_CONCURRENT_DOWNLOADS) {
      log.info("Download queued", { entryId, queuePosition: this.downloadQueue.length + 1 });
      this.downloadQueue.push(request);
      return new Promise((resolve, reject) => {
        const check = setInterval(async () => {
          if (this.activeDownloads.has(entryId)) {
            clearInterval(check);
          }
          const idx = this.downloadQueue.indexOf(request);
          if (idx === -1 && !this.activeDownloads.has(entryId)) {
            clearInterval(check);
            try {
              const result = await this.executeDownload(request);
              resolve(result);
            } catch (err) {
              reject(err);
            }
          }
        }, 500);
      });
    }

    return this.executeDownload(request);
  }

  /** Cancel a download */
  cancelDownload(entryId: string): void {
    const active = this.activeDownloads.get(entryId);
    if (active) {
      active.controller.abort();
      this.activeDownloads.delete(entryId);
      this.onProgressCallbacks.delete(entryId);
      log.info("Download cancelled", { entryId });
      this.processQueue();
    }

    const queueIdx = this.downloadQueue.findIndex((r) => r.entryId === entryId);
    if (queueIdx !== -1) {
      this.downloadQueue.splice(queueIdx, 1);
    }
  }

  /** Cancel all downloads */
  cancelAll(): void {
    for (const [entryId, active] of this.activeDownloads) {
      active.controller.abort();
      log.info("Download cancelled", { entryId });
    }
    this.activeDownloads.clear();
    this.downloadQueue = [];
    this.onProgressCallbacks.clear();
  }

  private async executeDirectDownload(request: DownloadRequest): Promise<AssetMapping> {
    const controller = new AbortController();
    const active: ActiveDownload = { request, controller, startTime: Date.now() };
    this.activeDownloads.set(request.entryId, active);

    try {
      log.info("Starting direct entry download", { entryId: request.entryId });

      // Always use raw CDN URL — the Kaltura API downloadUrl redirects, and
      // UXP's fetch throws "Already read" on response.arrayBuffer() after redirects
      const downloadUrl = this.mediaService.getEntryDownloadUrl(request.entryId, request.fileName);
      log.info("Entry download URL", { url: downloadUrl.substring(0, 150) });

      const response = await fetch(downloadUrl, {
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new NetworkError(`Download failed: HTTP ${response.status} ${response.statusText}`);
      }

      const buf = await response.arrayBuffer();
      const downloadedData = new Uint8Array(buf);
      const contentType = response.headers.get("content-type") || "";
      log.info("Downloaded entry data", {
        byteLength: downloadedData.byteLength,
        contentType,
      });

      if (downloadedData.byteLength === 0) {
        throw new NetworkError(`Download returned 0 bytes for entry ${request.entryId}`);
      }

      // Reject non-media responses (e.g. HTML error pages from CDN)
      const ctLower = contentType.split(";")[0].trim().toLowerCase();
      if (ctLower.startsWith("text/") || ctLower === "application/json") {
        throw new NetworkError(
          `Download returned non-media content (${ctLower}) for entry ${request.entryId}`,
        );
      }

      // Detect actual file type from Content-Type header or magic bytes
      const actualExt = detectFileExtension(contentType, downloadedData);
      const correctedFileName = actualExt
        ? request.fileName.replace(/\.[^.]+$/, `.${actualExt}`)
        : request.fileName;
      log.info("File type detection", { actualExt, correctedFileName });

      const progressCallback = this.onProgressCallbacks.get(request.entryId);
      progressCallback?.({
        entryId: request.entryId,
        loaded: downloadedData.byteLength,
        total: downloadedData.byteLength,
        percent: 100,
        speed: 0,
      });

      const tempPath = await this.saveTempFile(correctedFileName, downloadedData);
      log.info("File saved, importing into project", { tempPath, size: downloadedData.byteLength });
      const importResult = await this.hostService.importFile(tempPath);

      if (!importResult.success) {
        throw new Error(`Import failed: ${importResult.error || "Unknown error"}`);
      }

      const mapping: AssetMapping = {
        entryId: request.entryId,
        flavorId: "source",
        localPath: tempPath,
        importDate: Date.now(),
        isProxy: false,
      };

      this.hostService.storeMapping(request.entryId, tempPath);
      log.info("Direct download and import complete", {
        entryId: request.entryId,
        size: downloadedData.byteLength,
      });

      return mapping;
    } finally {
      this.activeDownloads.delete(request.entryId);
      this.onProgressCallbacks.delete(request.entryId);
      this.processQueue();
    }
  }

  private async executeDownload(request: DownloadRequest): Promise<AssetMapping> {
    const controller = new AbortController();
    const active: ActiveDownload = {
      request,
      controller,
      startTime: Date.now(),
    };
    this.activeDownloads.set(request.entryId, active);

    try {
      log.info("Starting download", { entryId: request.entryId, flavorId: request.flavorId });

      const downloadUrl = await this.mediaService.getFlavorDownloadUrl(
        request.entryId,
        request.flavorId,
      );
      log.info("Download URL", { url: downloadUrl.substring(0, 150) });

      const response = await fetch(downloadUrl, {
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new NetworkError(`Download failed: HTTP ${response.status} ${response.statusText}`);
      }

      const buf = await response.arrayBuffer();
      const downloadedData = new Uint8Array(buf);

      log.info("Downloaded data", {
        byteLength: downloadedData.byteLength,
        magic:
          downloadedData.length >= 8 ? String.fromCharCode(...downloadedData.slice(4, 8)) : "n/a",
      });

      if (downloadedData.byteLength === 0) {
        throw new NetworkError(
          `Download returned 0 bytes.\n` +
            `Status: ${response.status}\n` +
            `Content-Type: ${response.headers.get("content-type")}\n` +
            `Original URL: ${downloadUrl.substring(0, 150)}`,
        );
      }

      // Report 100% progress
      const progressCallback = this.onProgressCallbacks.get(request.entryId);
      progressCallback?.({
        entryId: request.entryId,
        loaded: downloadedData.byteLength,
        total: downloadedData.byteLength,
        percent: 100,
        speed: 0,
      });

      // Save file and import into host app
      const tempPath = await this.saveTempFile(request.fileName, downloadedData);
      log.info("File saved, importing into project", { tempPath, size: downloadedData.byteLength });
      const importResult = await this.hostService.importFile(tempPath);

      if (!importResult.success) {
        const errDetail = importResult.error || "Unknown error";
        log.error("Host import rejected file", {
          tempPath,
          error: errDetail,
          size: downloadedData.byteLength,
        });
        throw new Error(
          `Import failed: ${errDetail}\n` +
            `Path: ${tempPath}\n` +
            `Downloaded: ${downloadedData.byteLength} bytes`,
        );
      }

      const mapping: AssetMapping = {
        entryId: request.entryId,
        flavorId: request.flavorId,
        localPath: tempPath,
        importDate: Date.now(),
        isProxy: false,
      };

      this.hostService.storeMapping(request.entryId, tempPath);
      log.info("Download and import complete", {
        entryId: request.entryId,
        size: downloadedData.byteLength,
      });

      return mapping;
    } finally {
      this.activeDownloads.delete(request.entryId);
      this.onProgressCallbacks.delete(request.entryId);
      this.processQueue();
    }
  }

  private processQueue(): void {
    while (this.downloadQueue.length > 0 && this.activeDownloads.size < MAX_CONCURRENT_DOWNLOADS) {
      const next = this.downloadQueue.shift();
      if (next) {
        this.executeDownload(next).catch((err) => {
          log.error("Queued download failed", err);
        });
      }
    }
  }

  /**
   * Save downloaded data to the plugin-data folder using UXP's fs module.
   * Per Adobe docs, fs.writeFile supports Uint8Array for binary data
   * and plugin-data:/ URL scheme for the plugin's persistent data folder.
   */
  private async saveTempFile(fileName: string, data: Uint8Array): Promise<string> {
    const fs = require("fs");
    const pluginDataPath = `plugin-data:/${fileName}`;

    log.info("Writing file via UXP fs module", {
      path: pluginDataPath,
      size: data.byteLength,
      magic: data.length >= 8 ? String.fromCharCode(...data.slice(4, 8)) : "n/a",
    });

    // Write binary data using UXP fs.writeFile (supports Uint8Array natively)
    const bytesWritten = await fs.writeFile(pluginDataPath, data);
    log.info("fs.writeFile completed", { bytesWritten });

    // Verify the file was written correctly
    const stats = await fs.lstat(pluginDataPath);
    if (!stats.isFile() || stats.size === 0) {
      throw new Error(
        `File write verification failed: size=${stats.size}, expected=${data.byteLength}`,
      );
    }
    log.info("File verified", { size: stats.size });

    // Resolve native path for Premiere's importFiles API

    const uxp = require("uxp");
    const entry = await uxp.storage.localFileSystem.getEntryWithUrl(pluginDataPath);
    const nativePath = entry.nativePath;

    if (!nativePath || typeof nativePath !== "string") {
      throw new Error(`Could not resolve native path for ${pluginDataPath}`);
    }

    log.info("Saved file for import", { nativePath, size: stats.size });
    return nativePath;
  }
}
