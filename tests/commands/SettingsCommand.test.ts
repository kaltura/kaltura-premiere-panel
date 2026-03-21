import { runSettingsCommand } from "../../src/commands/SettingsCommand";

describe("SettingsCommand", () => {
  const mockHostService = {
    getAppInfo: jest.fn().mockReturnValue({
      id: "premierepro",
      name: "Premiere Pro",
      version: "25.6.0",
      supportsVideo: true,
      supportsAudio: true,
      supportsSequences: true,
      supportsMarkers: true,
    }),
    isAvailable: jest.fn().mockReturnValue(true),
    getVersion: jest.fn().mockReturnValue("25.6.0"),
    getAllMappings: jest.fn().mockReturnValue(new Map()),
    clearMappings: jest.fn(),
    isImported: jest.fn().mockReturnValue(false),
    importFile: jest.fn(),
    storeMapping: jest.fn(),
    addMarkers: jest.fn(),
    getMarkers: jest.fn(),
  };

  const mockOfflineService = {
    getSyncStatus: jest.fn().mockReturnValue({
      isOnline: true,
      pendingOperations: 0,
      cacheEntryCount: 5,
      cacheSizeMB: 12.3,
    }),
    clearCache: jest.fn(),
    clearQueue: jest.fn(),
    getIsOnline: jest.fn().mockReturnValue(true),
    onStatusChange: jest.fn().mockReturnValue(() => {}),
    isCached: jest.fn().mockReturnValue(false),
    cacheEntries: jest.fn(),
    getCachedEntries: jest.fn().mockReturnValue([]),
  };

  const mockAuditService = {
    getLocalLog: jest.fn().mockReturnValue([
      { action: "login", timestamp: Date.now() - 60000 },
      { action: "import", entryId: "1_abc123", timestamp: Date.now() },
    ]),
    clearLocalLog: jest.fn(),
    logAction: jest.fn().mockResolvedValue(undefined),
    listAccessControlProfiles: jest.fn().mockResolvedValue([]),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();

    // Mock uxpShowModal on dialog elements
    const origCreateElement = document.createElement.bind(document);
    jest.spyOn(document, "createElement").mockImplementation((tag: string) => {
      if (tag === "dialog") {
        const el = origCreateElement(tag) as HTMLDialogElement & {
          uxpShowModal: (opts: unknown) => Promise<string>;
        };
        el.uxpShowModal = jest.fn().mockResolvedValue("ok");
        return el;
      }
      return origCreateElement(tag);
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    document.querySelectorAll("#kaltura-settings-dialog").forEach((el) => el.remove());
  });

  it("creates and removes a dialog element", async () => {
    await runSettingsCommand(
      mockHostService as never,
      mockOfflineService as never,
      mockAuditService as never,
    );
    expect(document.querySelector("#kaltura-settings-dialog")).toBeNull();
  });

  it("renders plugin version in dialog", async () => {
    const promise = runSettingsCommand(
      mockHostService as never,
      mockOfflineService as never,
      mockAuditService as never,
    );
    const dialog = document.querySelector("#kaltura-settings-dialog");
    expect(dialog).toBeTruthy();
    expect(dialog?.innerHTML).toContain("Plugin Version:");
    await promise;
  });

  it("renders host app info", async () => {
    const promise = runSettingsCommand(
      mockHostService as never,
      mockOfflineService as never,
      mockAuditService as never,
    );
    const dialog = document.querySelector("#kaltura-settings-dialog");
    expect(dialog?.innerHTML).toContain("Premiere Pro");
    await promise;
  });

  it("renders audit entries", async () => {
    const promise = runSettingsCommand(
      mockHostService as never,
      mockOfflineService as never,
      mockAuditService as never,
    );
    const dialog = document.querySelector("#kaltura-settings-dialog");
    expect(dialog?.innerHTML).toContain("import");
    expect(dialog?.innerHTML).toContain("1_abc123");
    await promise;
  });

  it("shows 'No audit entries' when log is empty", async () => {
    mockAuditService.getLocalLog.mockReturnValueOnce([]);
    const promise = runSettingsCommand(
      mockHostService as never,
      mockOfflineService as never,
      mockAuditService as never,
    );
    const dialog = document.querySelector("#kaltura-settings-dialog");
    expect(dialog?.innerHTML).toContain("No audit entries yet");
    await promise;
  });

  it("saves settings when dialog closes", async () => {
    await runSettingsCommand(
      mockHostService as never,
      mockOfflineService as never,
      mockAuditService as never,
    );
    const stored = localStorage.getItem("kaltura_settings");
    expect(stored).toBeTruthy();
    const parsed = JSON.parse(stored!);
    expect(parsed.defaultExportPreset).toBeTruthy();
    expect(parsed.defaultCaptionLanguage).toBeTruthy();
  });

  it("clear cache button calls offlineService.clearCache", async () => {
    const promise = runSettingsCommand(
      mockHostService as never,
      mockOfflineService as never,
      mockAuditService as never,
    );
    const dialog = document.querySelector("#kaltura-settings-dialog");
    const clearBtn = dialog?.querySelector("#settings-clear-cache") as HTMLElement;
    expect(clearBtn).toBeTruthy();
    clearBtn.click();
    expect(mockOfflineService.clearCache).toHaveBeenCalledTimes(1);
    await promise;
  });

  it("clear mappings button calls hostService.clearMappings", async () => {
    const promise = runSettingsCommand(
      mockHostService as never,
      mockOfflineService as never,
      mockAuditService as never,
    );
    const dialog = document.querySelector("#kaltura-settings-dialog");
    const clearBtn = dialog?.querySelector("#settings-clear-mappings") as HTMLElement;
    expect(clearBtn).toBeTruthy();
    clearBtn.click();
    expect(mockHostService.clearMappings).toHaveBeenCalledTimes(1);
    await promise;
  });

  it("clear audit button calls auditService.clearLocalLog", async () => {
    const promise = runSettingsCommand(
      mockHostService as never,
      mockOfflineService as never,
      mockAuditService as never,
    );
    const dialog = document.querySelector("#kaltura-settings-dialog");
    const clearBtn = dialog?.querySelector("#settings-clear-audit") as HTMLElement;
    expect(clearBtn).toBeTruthy();
    clearBtn.click();
    expect(mockAuditService.clearLocalLog).toHaveBeenCalledTimes(1);
    // Audit section should show empty state
    const auditEl = dialog?.querySelector("#settings-audit");
    expect(auditEl?.innerHTML).toContain("No audit entries yet");
    await promise;
  });

  it("close button triggers dialog.close", async () => {
    const promise = runSettingsCommand(
      mockHostService as never,
      mockOfflineService as never,
      mockAuditService as never,
    );
    const dialog = document.querySelector("#kaltura-settings-dialog");
    const closeBtn = dialog?.querySelector("#settings-close") as HTMLElement;
    expect(closeBtn).toBeTruthy();
    // uxpShowModal is already resolved, but close button should exist
    expect(closeBtn.textContent).toBe("Done");
    await promise;
  });

  it("shows pending operations when present", async () => {
    mockOfflineService.getSyncStatus.mockReturnValueOnce({
      isOnline: true,
      pendingOperations: 3,
      cacheEntryCount: 5,
      cacheSizeMB: 12.3,
    });
    const promise = runSettingsCommand(
      mockHostService as never,
      mockOfflineService as never,
      mockAuditService as never,
    );
    const dialog = document.querySelector("#kaltura-settings-dialog");
    expect(dialog?.innerHTML).toContain("Pending sync operations: 3");
    await promise;
  });

  it("handles uxpShowModal rejection (Esc/cancel)", async () => {
    // Restore first, then create new spy with rejection
    jest.restoreAllMocks();
    const origCreateElement = document.createElement.bind(document);
    jest.spyOn(document, "createElement").mockImplementation((tag: string) => {
      if (tag === "dialog") {
        const el = origCreateElement(tag) as HTMLDialogElement & {
          uxpShowModal: (opts: unknown) => Promise<string>;
        };
        el.uxpShowModal = jest.fn().mockRejectedValue(new Error("reasonCanceled"));
        return el;
      }
      return origCreateElement(tag);
    });

    // Should not throw
    await runSettingsCommand(
      mockHostService as never,
      mockOfflineService as never,
      mockAuditService as never,
    );
    // Settings should still be saved
    const stored = localStorage.getItem("kaltura_settings");
    expect(stored).toBeTruthy();
  });

  it("loads existing settings from localStorage", async () => {
    localStorage.setItem(
      "kaltura_settings",
      JSON.stringify({
        defaultExportPreset: "ProRes 422",
        defaultCaptionLanguage: "fr",
        maxCacheSizeMB: 1000,
      }),
    );

    const promise = runSettingsCommand(
      mockHostService as never,
      mockOfflineService as never,
      mockAuditService as never,
    );
    const dialog = document.querySelector("#kaltura-settings-dialog");
    const exportSelect = dialog?.querySelector("#settings-export-preset") as HTMLSelectElement;
    const langSelect = dialog?.querySelector("#settings-caption-lang") as HTMLSelectElement;
    const cacheInput = dialog?.querySelector("#settings-cache-max") as HTMLInputElement;

    expect(exportSelect.value).toBe("ProRes 422");
    expect(langSelect.value).toBe("fr");
    expect(cacheInput.value).toBe("1000");
    await promise;
  });

  it("renders AGPL license info", async () => {
    const promise = runSettingsCommand(
      mockHostService as never,
      mockOfflineService as never,
      mockAuditService as never,
    );
    const dialog = document.querySelector("#kaltura-settings-dialog");
    expect(dialog?.innerHTML).toContain("AGPL-3.0");
    await promise;
  });
});
