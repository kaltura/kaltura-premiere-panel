import React, { Suspense, useMemo, useState, useCallback, useEffect } from "react";
import { TabId, KalturaMediaEntry, KalturaFlavorAsset } from "./types";
import type { CaptionSegment } from "./services/CaptionService";

import {
  KalturaClient,
  AuthService,
  MediaService,
  UploadService,
  DownloadService,
  MetadataService,
  CaptionService,
  BatchService,
  PublishWorkflowService,
  SearchService,
  AuditService,
  OfflineService,
  createHostService,
} from "./services";
import { useAuth } from "./hooks";
import { LoginPanel, BrowsePanel, PublishPanel } from "./panels";
import { StatusBar, LoadingSpinner } from "./components";

const SettingsPanel = React.lazy(() =>
  import("./panels/SettingsPanel").then((m) => ({ default: m.SettingsPanel })),
);
import { DEFAULT_SERVICE_URL } from "./utils/constants";
import { createLogger } from "./utils/logger";

const log = createLogger("App");
const PARTNER_ID = 0; // Set by login

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabId | null>("browse");
  const [importStatus, setImportStatus] = useState<{ message: string; isError: boolean } | null>(
    null,
  );

  // Initialize services (memoized)
  const client = useMemo(
    () => new KalturaClient({ serviceUrl: DEFAULT_SERVICE_URL, partnerId: PARTNER_ID }),
    [],
  );
  const authService = useMemo(() => new AuthService(client), [client]);
  const mediaService = useMemo(() => new MediaService(client), [client]);
  const uploadService = useMemo(() => new UploadService(client), [client]);
  const hostService = useMemo(() => createHostService(), []);
  const metadataService = useMemo(() => new MetadataService(client), [client]);
  const downloadService = useMemo(
    () => new DownloadService(client, mediaService, hostService),
    [client, mediaService, hostService],
  );
  const captionService = useMemo(() => new CaptionService(client), [client]);
  const batchService = useMemo(() => new BatchService(client), [client]);
  const publishWorkflowService = useMemo(
    () => new PublishWorkflowService(client, mediaService),
    [client, mediaService],
  );
  const searchService = useMemo(() => new SearchService(client), [client]);
  const auditService = useMemo(() => new AuditService(client), [client]);
  const offlineService = useMemo(() => new OfflineService(), []);

  const { authState, login, loginWithSso, cancelSso, logout, isLoading, error, clearError } =
    useAuth(client, authService);

  // Update client when auth changes
  useEffect(() => {
    if (authState.partnerId) {
      client.configure({ partnerId: authState.partnerId });
    }
  }, [authState.partnerId, client]);

  useEffect(() => {
    if (authState.isAuthenticated) {
      auditService.logAction("login", undefined, `User: ${authState.user?.email}`);
      hostService.syncWithProject?.();
    }
  }, [authState.isAuthenticated, authState.user?.email, auditService, hostService]);

  const handleServerUrlChange = useCallback(
    (url: string) => {
      client.configure({ serviceUrl: url });
    },
    [client],
  );

  const handleImportEntry = useCallback(
    async (entry: KalturaMediaEntry, flavor: KalturaFlavorAsset) => {
      if (!authState.partnerId) return;
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
    [authState.partnerId, downloadService, auditService],
  );

  const handleImportDirectEntry = useCallback(
    async (entry: KalturaMediaEntry) => {
      if (!authState.partnerId) return;
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
    },
    [authState.partnerId, downloadService, auditService],
  );

  const handleAttachToClip = useCallback(
    async (entryId: string, segments: CaptionSegment[]) => {
      if (!hostService.importTranscript) {
        return { success: false, error: "Transcript attachment is not supported in this host app" };
      }
      const result = await hostService.importTranscript(entryId, segments);
      if (result.success) {
        auditService.logAction("attachTranscript", entryId, `${segments.length} segments`);
      }
      return result;
    },
    [hostService, auditService],
  );

  /**
   * Two-phase tab switch to prevent UXP SWC preCreateCallback assertion crash.
   * Phase 1: set tab to null (unmounts current panel's SWC elements).
   * Phase 2: after a frame, mount the new panel.
   * This gives Spectrum Web Components time to fully tear down before new ones mount.
   */
  const safeTabSwitch = useCallback((id: TabId) => {
    setActiveTab(null);
    setTimeout(() => setActiveTab(id), 50);
  }, []);

  const handlePublished = useCallback(
    (_entry: KalturaMediaEntry) => {
      safeTabSwitch("browse");
    },
    [safeTabSwitch],
  );

  const handleTabSwitch = useCallback(
    (id: TabId) => {
      safeTabSwitch(id);
    },
    [safeTabSwitch],
  );

  // Auth gate
  if (isLoading && !authState.isAuthenticated) {
    return <LoadingSpinner label="Loading..." size="large" />;
  }

  if (!authState.isAuthenticated) {
    return (
      <div className="panel-root">
        <div
          style={{
            flexGrow: 1,
            flexShrink: 1,
            flexBasis: "0%",
            overflowY: "auto" as const,
            minHeight: 0,
          }}
        >
          <LoginPanel
            onLogin={login}
            onSsoLogin={loginWithSso}
            onCancelSso={cancelSso}
            onServerUrlChange={handleServerUrlChange}
            isLoading={isLoading}
            error={error}
            onClearError={clearError}
          />
        </div>
        <StatusBar connectionState={authState.connectionState} />
      </div>
    );
  }

  return (
    <div className="panel-root">
      {/* Tab bar */}
      <div className="tab-bar" role="tablist" aria-label="Panel navigation">
        <TabButton id="browse" label="Browse" active={activeTab} onClick={handleTabSwitch} />
        <TabButton id="publish" label="Publish" active={activeTab} onClick={handleTabSwitch} />
        <TabButton id="settings" label="Settings" active={activeTab} onClick={handleTabSwitch} />
      </div>

      {/* Tab content */}
      <div className="tab-content" role="tabpanel" aria-label={activeTab ?? undefined}>
        {activeTab === "browse" && authState.partnerId && (
          <BrowsePanel
            mediaService={mediaService}
            metadataService={metadataService}
            searchService={searchService}
            batchService={batchService}
            auditService={auditService}
            offlineService={offlineService}
            captionService={captionService}
            partnerId={authState.partnerId}
            userId={authState.user?.id}
            isImported={(id) => hostService.isImported(id)}
            onImportEntry={handleImportEntry}
            onImportDirectEntry={handleImportDirectEntry}
            onAttachToClip={handleAttachToClip}
          />
        )}
        {activeTab === "publish" && (
          <PublishPanel
            mediaService={mediaService}
            uploadService={uploadService}
            metadataService={metadataService}
            premiereService={hostService}
            publishWorkflowService={publishWorkflowService}
            auditService={auditService}
            onPublished={handlePublished}
          />
        )}
        <Suspense fallback={<LoadingSpinner label="Loading..." />}>
          {activeTab === "settings" && (
            <SettingsPanel
              currentServerUrl={authState.serverUrl}
              currentPartnerId={authState.partnerId}
              userName={authState.user?.fullName ?? null}
              userEmail={authState.user?.email ?? null}
              hostService={hostService}
              offlineService={offlineService}
              auditService={auditService}
              onLogout={logout}
            />
          )}
        </Suspense>
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

      {/* Status bar */}
      <StatusBar connectionState={authState.connectionState} />
    </div>
  );
};

// --- Tab button sub-component ---

interface TabButtonProps {
  id: TabId;
  label: string;
  active: TabId | null;
  onClick: (id: TabId) => void;
}

const TabButton: React.FC<TabButtonProps> = ({ id, label, active, onClick }) => (
  <div
    role="tab"
    tabIndex={active === id ? 0 : -1}
    aria-selected={active === id}
    aria-controls={`tabpanel-${id}`}
    onClick={() => onClick(id)}
    onKeyDown={(e) => {
      if (e.key === "Enter" || e.key === " ") onClick(id);
    }}
    className={`tab-btn${active === id ? " tab-btn--active" : ""}`}
  >
    {label}
  </div>
);
