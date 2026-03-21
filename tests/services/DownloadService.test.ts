import { DownloadService } from "../../src/services/DownloadService";
import { KalturaClient } from "../../src/services/KalturaClient";
import { MediaService } from "../../src/services/MediaService";
import { KalturaFlavorAsset } from "../../src/types/kaltura";

const mockFetch = global.fetch as jest.Mock;

function createMockHostService() {
  return {
    importFile: jest.fn().mockResolvedValue({ success: true }),
    isImported: jest.fn().mockReturnValue(false),
    storeMapping: jest.fn(),
  };
}

function mockFetchResponse(data: Uint8Array, contentType = "video/mp4") {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: {
      get: (name: string) => {
        if (name === "content-length") return String(data.byteLength);
        if (name === "content-type") return contentType;
        return null;
      },
    },
    arrayBuffer: () =>
      Promise.resolve(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)),
  };
}

describe("DownloadService", () => {
  let client: KalturaClient;
  let mediaService: MediaService;
  let hostService: ReturnType<typeof createMockHostService>;
  let service: DownloadService;

  const mockFlavor: KalturaFlavorAsset = {
    id: "flavor_1",
    entryId: "0_abc",
    partnerId: 12345,
    status: 2,
    size: 1024,
    width: 1920,
    height: 1080,
    bitrate: 4000,
    frameRate: 30,
    fileExt: "mp4",
    isWeb: true,
    isOriginal: false,
  };

  beforeEach(() => {
    client = new KalturaClient({ serviceUrl: "https://test.kaltura.com", partnerId: 12345 });
    client.setKs("test_ks");
    mediaService = new MediaService(client);
    hostService = createMockHostService();
    service = new DownloadService(client, mediaService, hostService);
    mockFetch.mockReset();
  });

  it("initializes with zero active downloads", () => {
    expect(service.activeCount).toBe(0);
    expect(service.queueLength).toBe(0);
  });

  it("re-downloads even if asset was previously imported", async () => {
    hostService.isImported.mockReturnValue(true);
    const existingFlavor = { ...mockFlavor, id: "flavor_existing", entryId: "0_existing" };

    // First fetch: getFlavorDownloadUrl API call
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => "https://cdn.kaltura.com/download/test.mp4",
    });
    // Second fetch: actual file download
    mockFetch.mockResolvedValueOnce(mockFetchResponse(new Uint8Array([1, 2, 3])));

    const result = await service.downloadAndImport("0_existing", existingFlavor);

    expect(result.entryId).toBe("0_existing");
    expect(result.flavorId).toBe("flavor_existing");
  });

  it("downloads file and creates mapping", async () => {
    // First fetch: getFlavorDownloadUrl API call
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => "https://cdn.kaltura.com/download/test.mp4",
    });
    // Second fetch: actual file download
    mockFetch.mockResolvedValueOnce(mockFetchResponse(new Uint8Array([1, 2, 3, 4])));

    const progressCalls: number[] = [];
    const result = await service.downloadAndImport("0_abc", mockFlavor, (p) => {
      progressCalls.push(p.percent);
    });

    expect(result.entryId).toBe("0_abc");
    expect(result.flavorId).toBe("flavor_1");
    expect(result.localPath).toContain("0_abc_flavor_1.mp4");
    expect(progressCalls.length).toBeGreaterThan(0);
  });

  it("resolves native path via getEntryWithUrl", async () => {
    // First fetch: getFlavorDownloadUrl API call
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => "https://cdn.kaltura.com/download/test.mp4",
    });
    // Second fetch: actual file download
    mockFetch.mockResolvedValueOnce(mockFetchResponse(new Uint8Array([1, 2])));

    const result = await service.downloadAndImport("0_abc", mockFlavor);

    expect(result.localPath).toBe("/tmp/kaltura-data/0_abc_flavor_1.mp4");
  });

  describe("downloadAndImportEntry()", () => {
    it("downloads an image entry directly using raw CDN URL", async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchResponse(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg"),
      );

      const result = await service.downloadAndImportEntry("0_img", "photo.jpg");

      expect(result.entryId).toBe("0_img");
      expect(result.flavorId).toBe("source");
      expect(result.localPath).toContain("0_img_source.jpg");
      expect(hostService.importFile).toHaveBeenCalled();
      expect(hostService.storeMapping).toHaveBeenCalledWith("0_img", expect.any(String));
      // Verify the fetch URL uses raw CDN path (no API call, no redirects)
      const fetchUrl = mockFetch.mock.calls[0][0];
      expect(fetchUrl).toContain("/raw/entry_id/0_img/direct_serve/1");
    });

    it("corrects extension based on Content-Type header", async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchResponse(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "image/png"),
      );

      const result = await service.downloadAndImportEntry("0_png", "screenshot.PNG");

      expect(result.localPath).toContain("0_png_source.png");
    });

    it("detects format from magic bytes when Content-Type is generic", async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchResponse(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "application/octet-stream"),
      );

      const result = await service.downloadAndImportEntry("0_noext", "ImageWithoutExt");

      expect(result.localPath).toContain("0_noext_source.png");
    });

    it("throws on empty download", async () => {
      mockFetch.mockResolvedValueOnce(mockFetchResponse(new Uint8Array([])));

      await expect(service.downloadAndImportEntry("0_empty", "empty.jpg")).rejects.toThrow(
        "0 bytes",
      );
    });
  });

  it("cancels a download", () => {
    service.cancelDownload("0_nonexistent");
    expect(service.activeCount).toBe(0);
  });

  it("cancels all downloads", () => {
    service.cancelAll();
    expect(service.activeCount).toBe(0);
    expect(service.queueLength).toBe(0);
  });
});
