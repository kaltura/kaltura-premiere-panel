/**
 * BrowsePanelRoot — entry point for the Media Browser panel.
 *
 * Wraps BrowsePanel in AuthGate + ErrorBoundary so the panel is
 * self-contained and independently dockable.
 */
import React, { useState, useCallback } from "react";
import { KalturaMediaEntry, KalturaFlavorAsset } from "../types/kaltura";
import type { CaptionSegment } from "../services/CaptionService";
import { AuthGate, AuthGateContext } from "../components/AuthGate";
import { BrowsePanel } from "./BrowsePanel";
import {
  mediaService,
  metadataService,
  searchService,
  batchService,
  auditService,
  offlineService,
  captionService,
  downloadService,
  hostService,
} from "../services/singleton";
import { createLogger } from "../utils/logger";

const log = createLogger("BrowsePanelRoot");

export const BrowsePanelRoot: React.FC = () => (
  <AuthGate panelTitle="Media Browser">{(ctx) => <BrowseContent {...ctx} />}</AuthGate>
);

const BrowseContent: React.FC<AuthGateContext> = ({ partnerId, userId }) => {
  const [importStatus, setImportStatus] = useState<{
    message: string;
    isError: boolean;
  } | null>(null);

  const handleImportEntry = useCallback(
    async (entry: KalturaMediaEntry, flavor: KalturaFlavorAsset) => {
      setImportStatus({ message: `Downloading "${entry.name}"...`, isError: false });
      try {
        log.info("Importing entry", { entryId: entry.id, flavorId: flavor.id });
        await downloadService.downloadAndImport(entry.id, flavor);
        auditService.logAction("import", entry.id, `Imported flavor ${flavor.id}`);
        setImportStatus({
          message: `"${entry.name}" imported to "Kaltura Assets" bin in the Project panel.`,
          isError: false,
        });
        setTimeout(() => setImportStatus(null), 4000);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Import failed";
        log.error("Import failed", err);
        setImportStatus({ message: `Import failed: ${message}`, isError: true });
      }
    },
    [],
  );

  const handleImportDirectEntry = useCallback(async (entry: KalturaMediaEntry) => {
    setImportStatus({ message: `Downloading "${entry.name}"...`, isError: false });
    try {
      log.info("Importing entry directly (no flavor)", { entryId: entry.id });
      await downloadService.downloadAndImportEntry(entry.id, entry.name);
      auditService.logAction("import", entry.id, "Imported source file (no flavor)");
      setImportStatus({
        message: `"${entry.name}" imported to "Kaltura Assets" bin in the Project panel.`,
        isError: false,
      });
      setTimeout(() => setImportStatus(null), 4000);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Import failed";
      log.error("Direct import failed", err);
      setImportStatus({ message: `Import failed: ${message}`, isError: true });
    }
  }, []);

  const handleAttachToClip = useCallback(async (entryId: string, segments: CaptionSegment[]) => {
    if (!hostService.importTranscript) {
      return { success: false, error: "Transcript attachment is not supported in this host app" };
    }
    const result = await hostService.importTranscript(entryId, segments);
    if (result.success) {
      auditService.logAction("attachTranscript", entryId, `${segments.length} segments`);
    }
    return result;
  }, []);

  return (
    <>
      <div
        className="tab-content"
        style={{ flexGrow: 1, flexShrink: 1, flexBasis: "0%", minHeight: 0 }}
      >
        <BrowsePanel
          mediaService={mediaService}
          metadataService={metadataService}
          searchService={searchService}
          batchService={batchService}
          auditService={auditService}
          offlineService={offlineService}
          captionService={captionService}
          partnerId={partnerId}
          userId={userId}
          onImportEntry={handleImportEntry}
          onImportDirectEntry={handleImportDirectEntry}
          onAttachToClip={handleAttachToClip}
        />
      </div>

      {/* Import status — aria-live for screen reader announcements */}
      <div aria-live="polite" aria-atomic="true">
        {importStatus && (
          <div
            className={`import-banner ${importStatus.isError ? "import-banner--error" : "import-banner--success"}`}
            role={importStatus.isError ? "alert" : "status"}
          >
            <span>{importStatus.message}</span>
            {importStatus.isError && (
              <button
                className="alert-dismiss"
                onClick={() => setImportStatus(null)}
                aria-label="Dismiss error"
              >
                {"\u2715"}
              </button>
            )}
          </div>
        )}
      </div>
    </>
  );
};
