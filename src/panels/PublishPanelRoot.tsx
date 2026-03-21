/**
 * PublishPanelRoot — entry point for the Publish panel.
 *
 * Wraps PublishPanel in AuthGate + ErrorBoundary so the panel is
 * self-contained and independently dockable.
 */
import React, { useCallback } from "react";
import { KalturaMediaEntry } from "../types/kaltura";
import { AuthGate } from "../components/AuthGate";
import { PublishPanel } from "./PublishPanel";
import {
  mediaService,
  uploadService,
  metadataService,
  publishWorkflowService,
  auditService,
  hostService,
} from "../services/singleton";

export const PublishPanelRoot: React.FC = () => (
  <AuthGate panelTitle="Publish">{(_ctx) => <PublishContent />}</AuthGate>
);

const PublishContent: React.FC = () => {
  // In multi-panel mode, "Back to Browse" no longer makes sense since
  // panels are independent. Published callback is a no-op.
  const handlePublished = useCallback((_entry: KalturaMediaEntry) => {
    // Panels are independent — no cross-panel navigation
  }, []);

  return (
    <div
      className="tab-content"
      style={{ flexGrow: 1, flexShrink: 1, flexBasis: "0%", minHeight: 0 }}
    >
      <PublishPanel
        mediaService={mediaService}
        uploadService={uploadService}
        metadataService={metadataService}
        premiereService={hostService}
        publishWorkflowService={publishWorkflowService}
        auditService={auditService}
        onPublished={handlePublished}
      />
    </div>
  );
};
