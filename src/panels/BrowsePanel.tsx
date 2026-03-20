import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  KalturaMediaEntry,
  KalturaFlavorAsset,
  KalturaCaptionAsset,
  KalturaCaptionType,
} from "../types/kaltura";
import { MediaService, BrowseHighlight, ESearchSortField } from "../services/MediaService";
import { MetadataService } from "../services/MetadataService";
import { CaptionService, CaptionSegment } from "../services/CaptionService";
import { createLogger } from "../utils/logger";

const log = createLogger("BrowsePanel");
import {
  LoadingSpinner,
  EmptyState,
  ErrorBanner,
  FilterBar,
  FilterState,
  defaultFilters,
  countActiveFilters,
  dateRangeToTimestamp,
  QualityPicker,
  MetadataEditor,
  SkeletonGrid,
} from "../components";
import { useDebounce, useContainerWidth, getGridColumns, getCardWidth } from "../hooks";
import {
  DEFAULT_PAGE_SIZE,
  SEARCH_DEBOUNCE_MS,
  INFINITE_SCROLL_THRESHOLD_PX,
  CONTENT_HOLD_TAG,
  HOLD_REASON_PREFIX,
  LICENSE_EXPIRY_WARNING_SECONDS,
} from "../utils/constants";
import { buildGridThumbnailUrl } from "../utils/thumbnail";
import { formatDuration, formatDate, formatFileSize, truncate } from "../utils/format";
import { getUserMessage } from "../utils/errors";

/** Check if a flavor asset is ready and usable for import */
function isFlavorReady(f: KalturaFlavorAsset): boolean {
  if (f.status !== 2) return false;
  // Accept flavors that have a nonzero size (covers audio with 0 width/height)
  if (f.size > 0) return true;
  // Accept flavors with known dimensions (video/image transcodes)
  if (f.width > 0 || f.height > 0) return true;
  return false;
}

/** Check if an entry is under content hold (governance) */
function isContentHeld(entry: KalturaMediaEntry): boolean {
  return Boolean(entry.adminTags && entry.adminTags.includes(CONTENT_HOLD_TAG));
}

/** Extract hold reason from adminTags */
function getHoldReason(entry: KalturaMediaEntry): string | null {
  if (!entry.adminTags) return null;
  const prefix = HOLD_REASON_PREFIX;
  const idx = entry.adminTags.indexOf(prefix);
  if (idx === -1) return null;
  const afterPrefix = entry.adminTags.slice(idx + prefix.length);
  const commaIdx = afterPrefix.indexOf(",");
  return commaIdx === -1 ? afterPrefix : afterPrefix.slice(0, commaIdx);
}

/** Check if entry has an end date that is expiring soon or expired */
function getLicenseStatus(entry: KalturaMediaEntry): "expired" | "expiring" | "active" | null {
  if (!entry.endDate || entry.endDate === 0) return null;
  const now = Math.floor(Date.now() / 1000);
  if (entry.endDate < now) return "expired";
  if (entry.endDate - now < LICENSE_EXPIRY_WARNING_SECONDS) return "expiring";
  return "active";
}

function formatCaptionFormat(format: KalturaCaptionType): string {
  switch (format) {
    case KalturaCaptionType.SRT:
      return "SRT";
    case KalturaCaptionType.DFXP:
      return "DFXP/TTML";
    case KalturaCaptionType.WEBVTT:
      return "WebVTT";
    case KalturaCaptionType.CAP:
      return "CAP";
    case KalturaCaptionType.SCC:
      return "SCC";
    default:
      return "Unknown";
  }
}

/** Truncate highlight text for display */
function truncateHighlight(text: string, max: number): string {
  if (!text || text.length <= max) return text;
  return text.slice(0, max) + "\u2026";
}

/** Format the first highlight for an entry into a short display string (grid cards) */
function formatHighlightHint(highlights: BrowseHighlight[]): string | null {
  if (highlights.length === 0) return null;
  const h = highlights[0];
  const snippet = h.text ? `: "${truncateHighlight(h.text, 40)}"` : "";
  if (h.type === "caption" && h.startTime !== undefined) {
    const totalSec = Math.floor(h.startTime / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `transcript \u23F1 ${m}:${String(s).padStart(2, "0")}${snippet}`;
  }
  if (h.type === "caption") return `transcript${snippet}`;
  if (h.type === "metadata") return `metadata${snippet}`;
  return `title/tags${snippet}`;
}

/** Format highlight for list row (slightly more verbose) */
function formatHighlightMeta(highlights: BrowseHighlight[]): string | null {
  if (highlights.length === 0) return null;
  const h = highlights[0];
  const snippet = h.text ? `: "${truncateHighlight(h.text, 60)}"` : "";
  if (h.type === "caption" && h.startTime !== undefined) {
    const totalSec = Math.floor(h.startTime / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `transcript at ${m}:${String(s).padStart(2, "0")}${snippet}`;
  }
  if (h.type === "caption") return `transcript${snippet}`;
  if (h.type === "metadata") return `metadata${snippet}`;
  return `title/tags${snippet}`;
}

/** Duck-typed SearchService for enhanced transcript/in-video search */
interface SearchServiceLike {
  searchTranscripts(
    entryId: string,
    searchText: string,
  ): Promise<{ startTime: number; endTime: number; text: string; highlight: string }[]>;
}

/** Duck-typed BatchService for bulk operations */
interface BatchServiceLike {
  batchDelete(entryIds: string[]): Promise<{ total: number; successful: number }>;
  batchUpdateMetadata(
    updates: { entryId: string; name?: string; tags?: string }[],
  ): Promise<{ total: number; successful: number }>;
}

/** Duck-typed AuditService for access control info */
interface AuditServiceLike {
  getAccessControlProfile(profileId: number): Promise<{
    id: number;
    name: string;
    restrictions: { type: string; description: string }[];
  } | null>;
}

/** Duck-typed OfflineService for caching */
interface OfflineServiceLike {
  getIsOnline(): boolean;
  isCached(entryId: string): boolean;
  cacheEntries(entries: KalturaMediaEntry[]): void;
  getCachedEntries(): { entry: KalturaMediaEntry; cachedAt: number }[];
  getSyncStatus(): { isOnline: boolean; pendingOperations: number; cacheEntryCount: number };
  onStatusChange(listener: (online: boolean) => void): () => void;
}

interface BrowsePanelProps {
  mediaService: MediaService;
  metadataService: MetadataService;
  searchService?: SearchServiceLike;
  batchService?: BatchServiceLike;
  auditService?: AuditServiceLike;
  offlineService?: OfflineServiceLike;
  captionService: CaptionService;
  partnerId: number;
  userId?: string;
  isImported: (entryId: string) => boolean;
  onImportEntry: (entry: KalturaMediaEntry, flavor: KalturaFlavorAsset) => void;
  onImportDirectEntry?: (entry: KalturaMediaEntry) => void;
  onAttachToClip?: (
    entryId: string,
    segments: CaptionSegment[],
  ) => Promise<{ success: boolean; error?: string }>;
}

interface EntryDetails {
  entry: KalturaMediaEntry;
  flavors: KalturaFlavorAsset[];
  captions: KalturaCaptionAsset[];
}

export const BrowsePanel: React.FC<BrowsePanelProps> = ({
  mediaService,
  metadataService,
  searchService: _searchService,
  batchService,
  auditService,
  offlineService,
  captionService,
  partnerId,
  userId,
  isImported,
  onImportEntry,
  onImportDirectEntry,
  onAttachToClip,
}) => {
  const [entries, setEntries] = useState<KalturaMediaEntry[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [searchText, setSearchText] = useState("");
  const [isOffline, setIsOffline] = useState(!offlineService?.getIsOnline());
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [selectedEntry, setSelectedEntry] = useState<EntryDetails | null>(null);
  const [showDetail, setShowDetail] = useState(false);
  const [filters, setFilters] = useState<FilterState>(defaultFilters);
  const [showQualityPicker, setShowQualityPicker] = useState(false);
  const [selectedFlavor, setSelectedFlavor] = useState<KalturaFlavorAsset | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [sortField, setSortField] = useState<ESearchSortField>("updated_at");

  const [highlights, setHighlights] = useState<Map<string, BrowseHighlight[]>>(new Map());

  const debouncedSearch = useDebounce(searchText, SEARCH_DEBOUNCE_MS);
  const prevSearch = useRef(debouncedSearch);

  // Auto-switch sort: relevance when searching, updated_at when cleared
  useEffect(() => {
    if (debouncedSearch && !prevSearch.current) {
      setSortField("relevance");
    } else if (!debouncedSearch && prevSearch.current && sortField === "relevance") {
      setSortField("updated_at");
    }
    prevSearch.current = debouncedSearch;
  }, [debouncedSearch, sortField]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const containerWidth = useContainerWidth(gridRef);
  const gridColumns = getGridColumns(containerWidth);
  const cardWidth = getCardWidth(gridColumns, 8, containerWidth);
  const activeFilterCount = countActiveFilters(filters);

  const loadEntries = useCallback(
    async (pageIndex: number, append: boolean = false) => {
      if (pageIndex === 1) {
        setIsLoading(true);
      } else {
        setIsLoadingMore(true);
      }
      setError(null);

      try {
        const eResult = await mediaService.eSearchBrowse(
          {
            searchText: debouncedSearch || undefined,
            mediaType: filters.mediaType ?? undefined,
            createdAfter: filters.dateRange ? dateRangeToTimestamp(filters.dateRange) : undefined,
            userId: filters.ownerFilter === "mine" && userId ? userId : undefined,
            categoryIds: filters.categoryId !== null ? String(filters.categoryId) : undefined,
            withCaptionsOnly: filters.withCaptionsOnly,
            sortField,
            sortOrder: sortField === "name" ? "asc" : "desc",
          },
          { pageSize: DEFAULT_PAGE_SIZE, pageIndex },
        );

        setEntries((prev) => (append ? [...prev, ...eResult.entries] : eResult.entries));
        setTotalCount(eResult.totalCount);
        setPage(pageIndex);
        setHighlights((prev) => {
          if (append) {
            const merged = new Map(prev);
            eResult.highlights.forEach((v, k) => merged.set(k, v));
            return merged;
          }
          return eResult.highlights;
        });

        // Cache results for offline access
        if (offlineService && eResult.entries.length > 0) {
          offlineService.cacheEntries(eResult.entries);
        }
      } catch (err) {
        log.error("Failed to load entries", err);
        setError(getUserMessage(err));
      } finally {
        setIsLoading(false);
        setIsLoadingMore(false);
      }
    },
    [mediaService, offlineService, debouncedSearch, filters, userId, sortField],
  );

  // Subscribe to offline status changes
  useEffect(() => {
    if (!offlineService) return;
    return offlineService.onStatusChange((online) => {
      setIsOffline(!online);
      if (online) loadEntries(1); // Refresh when coming back online
    });
  }, [offlineService, loadEntries]);

  // Reload when search or filters change
  useEffect(() => {
    if (isOffline && offlineService) {
      // Show cached entries when offline
      const cached = offlineService.getCachedEntries();
      const cachedEntries = cached.map((c) => c.entry);
      setEntries(cachedEntries);
      setTotalCount(cachedEntries.length);
      return;
    }
    loadEntries(1);
  }, [loadEntries, isOffline, offlineService]);

  // Infinite scroll
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || isLoadingMore || isLoading) return;

    const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
    const hasMore = entries.length < totalCount;

    if (remaining < INFINITE_SCROLL_THRESHOLD_PX && hasMore) {
      loadEntries(page + 1, true);
    }
  }, [entries.length, totalCount, page, isLoadingMore, isLoading, loadEntries]);

  const handleEntryClick = useCallback(
    async (entry: KalturaMediaEntry) => {
      try {
        const details = await mediaService.getEntryDetails(entry.id);
        setSelectedEntry(details);
        setShowDetail(true);
      } catch {
        setSelectedEntry({ entry, flavors: [], captions: [] });
        setShowDetail(true);
      }
    },
    [mediaService],
  );

  const [importError, setImportError] = useState<string | null>(null);

  const handleBackToGrid = useCallback(() => {
    setShowDetail(false);
    setSelectedEntry(null);
    setShowQualityPicker(false);
    setSelectedFlavor(null);
    setIsEditing(false);
    setImportError(null);
  }, []);

  const handleImportClick = useCallback(() => {
    setImportError(null);
    if (!selectedEntry) return;
    if (isContentHeld(selectedEntry.entry)) {
      setImportError("This entry is under content hold and cannot be imported.");
      return;
    }
    const readyFlavors = selectedEntry.flavors.filter(isFlavorReady);
    if (readyFlavors.length === 0) {
      // No transcoded flavors — fall back to direct source download
      if (onImportDirectEntry) {
        onImportDirectEntry(selectedEntry.entry);
        return;
      }
      setImportError("No ready renditions available for this entry.");
      return;
    }
    if (readyFlavors.length === 1) {
      onImportEntry(selectedEntry.entry, readyFlavors[0]);
      return;
    }
    // Pre-select the smallest web flavor as default
    const webFlavors = readyFlavors.filter((f) => f.isWeb);
    const defaultFlavor =
      webFlavors.length > 0
        ? webFlavors.reduce((a, b) => ((a.height || 0) < (b.height || 0) ? a : b))
        : readyFlavors[0];
    setSelectedFlavor(defaultFlavor);
    setShowQualityPicker(true);
  }, [selectedEntry, onImportEntry, onImportDirectEntry]);

  const handleQualityConfirm = useCallback(() => {
    if (selectedEntry && selectedFlavor) {
      onImportEntry(selectedEntry.entry, selectedFlavor);
      setShowQualityPicker(false);
    }
  }, [selectedEntry, selectedFlavor, onImportEntry]);

  const handleQuickImport = useCallback(
    (entry: KalturaMediaEntry) => {
      if (isContentHeld(entry)) return;
      mediaService
        .getEntryDetails(entry.id)
        .then((details) => {
          const ready = details.flavors.filter(isFlavorReady);
          const webFlavor = ready.find((f) => f.isWeb);
          if (webFlavor) onImportEntry(entry, webFlavor);
          else if (ready.length > 0) onImportEntry(entry, ready[0]);
          else if (onImportDirectEntry) onImportDirectEntry(entry);
        })
        .catch((err) => {
          log.error("Quick import failed", err);
        });
    },
    [mediaService, onImportEntry, onImportDirectEntry],
  );

  const handleMetadataSaved = useCallback(
    (updated: KalturaMediaEntry) => {
      setIsEditing(false);
      if (selectedEntry) {
        setSelectedEntry({ ...selectedEntry, entry: updated });
      }
      // Update in the grid
      setEntries((prev) => prev.map((e) => (e.id === updated.id ? updated : e)));
    },
    [selectedEntry],
  );

  // Metadata editor view
  if (isEditing && selectedEntry) {
    return (
      <MetadataEditor
        entry={selectedEntry.entry}
        metadataService={metadataService}
        onSave={handleMetadataSaved}
        onCancel={() => setIsEditing(false)}
      />
    );
  }

  // Asset detail flyout
  if (showDetail && selectedEntry) {
    return (
      <AssetDetail
        details={selectedEntry}
        partnerId={partnerId}
        captionService={captionService}
        onBack={handleBackToGrid}
        onImport={handleImportClick}
        onEdit={() => setIsEditing(true)}
        onDelete={
          batchService
            ? async () => {
                await batchService.batchDelete([selectedEntry.entry.id]);
                handleBackToGrid();
                loadEntries(1);
              }
            : undefined
        }
        isImported={isImported(selectedEntry.entry.id)}
        importError={importError}
        showQualityPicker={showQualityPicker}
        selectedFlavor={selectedFlavor}
        onFlavorSelect={setSelectedFlavor}
        onQualityCancel={() => setShowQualityPicker(false)}
        onQualityConfirm={handleQualityConfirm}
        auditService={auditService}
        onAttachToClip={onAttachToClip}
      />
    );
  }

  return (
    <div className="panel-root">
      {/* Search bar */}
      <div className="search-bar">
        <sp-textfield
          placeholder="Search media library..."
          value={searchText}
          onInput={(e: Event) => setSearchText((e.target as HTMLInputElement).value)}
          style={{ flexGrow: 1, flexShrink: 1, flexBasis: "0%", minWidth: 0, width: "100%" }}
          size="s"
          aria-label="Search Kaltura media library"
        />
        {searchText && (
          <sp-action-button
            quiet
            size="s"
            onClick={() => setSearchText("")}
            title="Clear search"
            style={{ marginLeft: 4 }}
          >
            {"\u2715"}
          </sp-action-button>
        )}
        <sp-action-button
          quiet
          size="s"
          onClick={() => setViewMode(viewMode === "grid" ? "list" : "grid")}
          title={viewMode === "grid" ? "Switch to list view" : "Switch to grid view"}
          style={{ marginLeft: 4 }}
        >
          {viewMode === "grid" ? "List" : "Grid"}
        </sp-action-button>
      </div>

      {/* Filter & sort bar */}
      <FilterBar
        filters={filters}
        onFiltersChange={setFilters}
        activeFilterCount={activeFilterCount}
        sortField={sortField}
        onSortChange={setSortField}
        hasSearchText={!!debouncedSearch}
      />

      {/* Result count */}
      {!isLoading && totalCount > 0 && (
        <div className="result-count">
          Showing {entries.length} of {totalCount} results
        </div>
      )}
      {!isLoading && totalCount === 0 && (searchText || activeFilterCount > 0) && (
        <div className="result-count">No results</div>
      )}

      {/* Offline mode banner */}
      {isOffline && (
        <div className="offline-banner">
          <span style={{ fontSize: "14px" }}>{"\u26A0"}</span>
          <span>
            <strong>Offline Mode</strong> — Showing {entries.length} cached assets.
            {offlineService && offlineService.getSyncStatus().pendingOperations > 0 && (
              <span>
                {" "}
                {offlineService.getSyncStatus().pendingOperations} pending operations will sync when
                online.
              </span>
            )}
          </span>
        </div>
      )}

      {error && <ErrorBanner message={error} onRetry={() => loadEntries(1)} />}

      {/* Content */}
      <div ref={scrollRef} onScroll={handleScroll} className="panel-scroll">
        {isLoading ? (
          <div ref={gridRef}>
            <SkeletonGrid count={(gridColumns || 3) * 2} columnWidth={cardWidth || undefined} />
          </div>
        ) : entries.length === 0 ? (
          <EmptyState
            title={searchText || activeFilterCount > 0 ? "No results found" : "No assets yet"}
            description={
              searchText || activeFilterCount > 0
                ? "Try different search terms or clear filters."
                : "Your Kaltura library is empty."
            }
          />
        ) : viewMode === "grid" ? (
          <div ref={gridRef} className="thumb-grid">
            {entries.map((entry) => (
              <ThumbnailCard
                key={entry.id}
                entry={entry}
                partnerId={partnerId}
                imported={isImported(entry.id)}
                cardWidth={cardWidth || undefined}
                highlightHint={formatHighlightHint(highlights.get(entry.id) || [])}
                searchQuery={debouncedSearch}
                onClick={() => handleEntryClick(entry)}
                onDoubleClick={() => handleQuickImport(entry)}
              />
            ))}
          </div>
        ) : (
          <div className="flex-col gap-2">
            {entries.map((entry) => (
              <ListRow
                key={entry.id}
                entry={entry}
                partnerId={partnerId}
                imported={isImported(entry.id)}
                highlightMeta={formatHighlightMeta(highlights.get(entry.id) || [])}
                searchQuery={debouncedSearch}
                onClick={() => handleEntryClick(entry)}
                onDoubleClick={() => handleQuickImport(entry)}
              />
            ))}
          </div>
        )}

        {isLoadingMore && <LoadingSpinner label="Loading more..." size="small" />}
      </div>
    </div>
  );
};

// --- Sub-components ---

/** Renders text with the search term highlighted in accent color */
const HighlightText: React.FC<{ text: string; query: string }> = ({ text, query }) => {
  if (!query) return <>{text}</>;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return <>{text}</>;
  const before = text.slice(0, idx);
  const match = text.slice(idx, idx + query.length);
  const after = text.slice(idx + query.length);
  return (
    <>
      {before}
      <span className="search-match">{match}</span>
      {after}
    </>
  );
};

interface ThumbnailCardProps {
  entry: KalturaMediaEntry;
  partnerId: number;
  imported: boolean;
  cardWidth?: string;
  highlightHint?: string | null;
  searchQuery?: string;
  onClick: () => void;
  onDoubleClick: () => void;
}

const ThumbnailCard: React.FC<ThumbnailCardProps> = ({
  entry,
  partnerId,
  imported,
  cardWidth,
  highlightHint,
  searchQuery,
  onClick,
  onDoubleClick,
}) => (
  <div
    onClick={onClick}
    onDoubleClick={onDoubleClick}
    className="thumb-card"
    title={entry.name}
    style={cardWidth ? { width: cardWidth } : undefined}
  >
    <div className="thumb-card-img-wrap">
      <img src={buildGridThumbnailUrl(partnerId, entry.id)} alt={entry.name} loading="lazy" />
      {entry.duration > 0 && <div className="badge-duration">{formatDuration(entry.duration)}</div>}
      {isContentHeld(entry) && (
        <div className="badge-overlay badge-hold" title={getHoldReason(entry) ?? "Content held"}>
          HOLD
        </div>
      )}
      {getLicenseStatus(entry) === "expired" && (
        <div
          className="badge-overlay badge-expired"
          style={isContentHeld(entry) ? { top: 20 } : undefined}
        >
          EXPIRED
        </div>
      )}
      {getLicenseStatus(entry) === "expiring" && (
        <div
          className="badge-overlay badge-expiring"
          style={isContentHeld(entry) ? { top: 20 } : undefined}
          title={`Expires: ${formatDate(entry.endDate!)}`}
        >
          EXPIRING
        </div>
      )}
      {imported && <div className="badge-imported">{"\u2713"}</div>}
    </div>
    <div className={`thumb-card-label${isContentHeld(entry) ? " text-error" : ""}`}>
      <HighlightText text={truncate(entry.name, 30)} query={searchQuery || ""} />
    </div>
    {highlightHint && <div className="highlight-hint">{highlightHint}</div>}
  </div>
);

interface ListRowProps {
  entry: KalturaMediaEntry;
  partnerId: number;
  imported: boolean;
  highlightMeta?: string | null;
  searchQuery?: string;
  onClick: () => void;
  onDoubleClick: () => void;
}

const ListRow: React.FC<ListRowProps> = ({
  entry,
  partnerId,
  imported,
  highlightMeta,
  searchQuery,
  onClick,
  onDoubleClick,
}) => (
  <div onClick={onClick} onDoubleClick={onDoubleClick} className="list-row">
    <img
      src={buildGridThumbnailUrl(partnerId, entry.id)}
      alt=""
      loading="lazy"
      className="list-row-thumb"
    />
    <div className="list-row-info">
      <div className={`list-row-name ellipsis${isContentHeld(entry) ? " text-error" : ""}`}>
        {isContentHeld(entry) && <span className="badge-inline badge-hold">HOLD</span>}
        {imported && "\u2713\u0020"}
        <HighlightText text={entry.name} query={searchQuery || ""} />
      </div>
      <div className="list-row-meta">
        {formatDuration(entry.duration)} {"\u00B7"} {formatDate(entry.createdAt)}
        {isContentHeld(entry) && (
          <span className="text-error" style={{ marginLeft: 4 }}>
            {`Hold: ${getHoldReason(entry) || "Content held"}`}
          </span>
        )}
        {getLicenseStatus(entry) === "expired" && (
          <span className="text-warning-orange" style={{ marginLeft: 4 }}>
            License expired
          </span>
        )}
        {getLicenseStatus(entry) === "expiring" && (
          <span className="text-warning-yellow" style={{ marginLeft: 4 }}>
            Expiring: {formatDate(entry.endDate!)}
          </span>
        )}
        {highlightMeta && (
          <span className="highlight-source" style={{ marginLeft: 4 }}>
            {"\u00B7"} {highlightMeta}
          </span>
        )}
      </div>
    </div>
  </div>
);

// --- Asset Detail View ---

type DetailSection = "info" | "captions";

interface AssetDetailProps {
  details: EntryDetails;
  partnerId: number;
  captionService: CaptionService;
  onBack: () => void;
  onImport: () => void;
  onEdit: () => void;
  onDelete?: () => void;
  isImported: boolean;
  importError: string | null;
  showQualityPicker: boolean;
  selectedFlavor: KalturaFlavorAsset | null;
  onFlavorSelect: (flavor: KalturaFlavorAsset) => void;
  onQualityCancel: () => void;
  onQualityConfirm: () => void;
  auditService?: AuditServiceLike;
  onAttachToClip?: (
    entryId: string,
    segments: CaptionSegment[],
  ) => Promise<{ success: boolean; error?: string }>;
}

const AssetDetail: React.FC<AssetDetailProps> = ({
  details,
  partnerId,
  captionService,
  onBack,
  onImport,
  onEdit,
  onDelete,
  isImported,
  importError,
  showQualityPicker,
  selectedFlavor,
  onFlavorSelect,
  onQualityCancel,
  onQualityConfirm,
  auditService,
  onAttachToClip,
}) => {
  const { entry, flavors } = details;
  const readyFlavors = flavors.filter(isFlavorReady);
  const [activeSection, setActiveSection] = useState<DetailSection>("info");

  const [accessControl, setAccessControl] = useState<{
    name: string;
    restrictions: { type: string; description: string }[];
  } | null>(null);
  useEffect(() => {
    if (!auditService) return;
    if (entry.accessControlId) {
      auditService.getAccessControlProfile(entry.accessControlId).then((profile) => {
        if (profile) setAccessControl({ name: profile.name, restrictions: profile.restrictions });
      });
    }
  }, [auditService, entry.accessControlId]);

  return (
    <div className="panel-root">
      {/* Back button bar */}
      <div className="detail-header">
        <div
          className="detail-back-btn"
          role="button"
          tabIndex={0}
          onClick={onBack}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") onBack();
          }}
        >
          {"\u2190"} Back
        </div>
      </div>

      {/* Hero */}
      <div className="detail-hero">
        <img
          src={buildGridThumbnailUrl(partnerId, entry.id)}
          alt={entry.name}
          className="detail-hero-img"
        />
        <div className="detail-hero-overlay">
          <div className="detail-hero-title">{entry.name}</div>
          <div className="detail-hero-subtitle">
            {formatDuration(entry.duration)} {"\u00B7"} {formatDate(entry.createdAt)}
          </div>
        </div>
      </div>

      {/* Section tabs */}
      <div className="sub-tabs" style={{ padding: "4px 8px", margin: "0" }}>
        <button
          className={`sub-tab${activeSection === "info" ? " sub-tab--active" : ""}`}
          onClick={() => setActiveSection("info")}
        >
          Info
        </button>
        <button
          className={`sub-tab${activeSection === "captions" ? " sub-tab--active" : ""}`}
          onClick={() => setActiveSection("captions")}
        >
          Captions
        </button>
      </div>

      {/* Quality picker overlay */}
      {showQualityPicker && (
        <QualityPicker
          flavors={readyFlavors}
          selectedFlavorId={selectedFlavor?.id ?? null}
          onSelect={onFlavorSelect}
          onCancel={onQualityCancel}
          onConfirm={onQualityConfirm}
        />
      )}

      <div className="detail-scroll">
        {activeSection === "info" && (
          <InfoSection entry={entry} readyFlavors={readyFlavors} accessControl={accessControl} />
        )}
        {activeSection === "captions" && (
          <CaptionSection
            entryId={entry.id}
            captionService={captionService}
            initialCaptions={details.captions}
            isVideoImported={isImported}
            onAttachToClip={onAttachToClip}
          />
        )}
      </div>

      {/* Action bar */}
      <div className="detail-actions">
        {importError && (
          <div className="alert-error" style={{ margin: 0 }}>
            {importError}
          </div>
        )}
        {isImported && !importError && (
          <div className="alert-info" style={{ margin: 0 }}>
            {"\u2713"} Previously imported. Look in <strong>Kaltura Assets</strong> bin in the
            Project panel.
          </div>
        )}
        <div className="detail-actions-row">
          {onDelete && (
            <div
              className="detail-delete-btn"
              role="button"
              tabIndex={0}
              onClick={onDelete}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") onDelete();
              }}
              title="Delete entry"
            >
              {"\u2716"}
            </div>
          )}
          <div
            className="detail-btn detail-btn--secondary"
            role="button"
            tabIndex={0}
            onClick={onEdit}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") onEdit();
            }}
          >
            Edit Metadata
          </div>
          <div
            className={`detail-btn ${isContentHeld(entry) ? "detail-btn--disabled" : "detail-btn--primary"}`}
            role="button"
            tabIndex={isContentHeld(entry) ? -1 : 0}
            onClick={isContentHeld(entry) ? undefined : onImport}
            onKeyDown={
              isContentHeld(entry)
                ? undefined
                : (e) => {
                    if (e.key === "Enter" || e.key === " ") onImport();
                  }
            }
            aria-disabled={isContentHeld(entry) || undefined}
          >
            {isContentHeld(entry)
              ? "Import Blocked"
              : isImported
                ? "Re-import to Project"
                : "Import to Project"}
          </div>
        </div>
      </div>
    </div>
  );
};

// --- Info Section ---

const InfoSection: React.FC<{
  entry: KalturaMediaEntry;
  readyFlavors: KalturaFlavorAsset[];
  accessControl: { name: string; restrictions: { type: string; description: string }[] } | null;
}> = ({ entry, readyFlavors, accessControl }) => {
  const holdReason = getHoldReason(entry);
  const licenseStatus = getLicenseStatus(entry);

  return (
    <>
      {/* Governance warnings */}
      {isContentHeld(entry) && (
        <div className="section-info section-info-error">
          <strong>Content Hold</strong>
          <div style={{ marginTop: 4 }}>
            {holdReason
              ? `Reason: ${holdReason}`
              : "This entry is under content hold and cannot be imported."}
          </div>
        </div>
      )}
      {(licenseStatus === "expired" || licenseStatus === "expiring") && (
        <div
          className={`section-info ${licenseStatus === "expired" ? "section-info-error" : "section-info-warning"}`}
        >
          <strong>
            {licenseStatus === "expired" ? "License Expired" : "License Expiring Soon"}
          </strong>
          <div style={{ marginTop: 4 }}>
            {licenseStatus === "expired"
              ? `This content's license expired on ${formatDate(entry.endDate!)}.`
              : `This content's license expires on ${formatDate(entry.endDate!)}. Review usage rights before importing.`}
          </div>
        </div>
      )}

      {/* Details */}
      <div className="detail-section">
        <div className="detail-section-title">Details</div>
        {entry.description && (
          <div className="detail-field">
            <span className="detail-field-value">{entry.description}</span>
          </div>
        )}
        <div className="detail-fields-grid">
          {entry.tags && (
            <div className="detail-field">
              <span className="detail-field-label">Tags</span>
              <span className="detail-field-value">{entry.tags}</span>
            </div>
          )}
          {entry.categories && (
            <div className="detail-field">
              <span className="detail-field-label">Categories</span>
              <span className="detail-field-value">{entry.categories}</span>
            </div>
          )}
          <div className="detail-field">
            <span className="detail-field-label">Entry ID</span>
            <span className="detail-field-value text-mono">{entry.id}</span>
          </div>
          {entry.userId && (
            <div className="detail-field">
              <span className="detail-field-label">Owner</span>
              <span className="detail-field-value">{entry.userId}</span>
            </div>
          )}
        </div>
      </div>

      {/* Access control */}
      {accessControl && (
        <div className="detail-section">
          <div className="detail-section-title">Access Control</div>
          <div className="detail-field">
            <span className="detail-field-label">Profile</span>
            <span className="detail-field-value">{accessControl.name}</span>
          </div>
          {accessControl.restrictions.length > 0 &&
            accessControl.restrictions.map((r, i) => (
              <div key={i} className="detail-field">
                <span className="detail-field-label">{r.type}</span>
                <span className="detail-field-value">{r.description}</span>
              </div>
            ))}
        </div>
      )}

      {/* Available qualities */}
      {readyFlavors.length > 0 && (
        <div className="detail-section">
          <div className="detail-section-title">Available Qualities ({readyFlavors.length})</div>
          {readyFlavors.map((f) => (
            <div key={f.id} className="quality-item">
              <span className="quality-resolution">
                {f.width}
                {"\u00D7"}
                {f.height}
              </span>
              <span className="quality-meta">
                {f.fileExt} {"\u00B7"} {formatFileSize(f.size * 1024)}
              </span>
              {(f.isOriginal || f.isWeb) && (
                <span className="quality-badge">{f.isOriginal ? "Original" : "Web"}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
};

// --- Caption Section ---

const CaptionSection: React.FC<{
  entryId: string;
  captionService: CaptionService;
  initialCaptions: KalturaCaptionAsset[];
  isVideoImported: boolean;
  onAttachToClip?: (
    entryId: string,
    segments: CaptionSegment[],
  ) => Promise<{ success: boolean; error?: string }>;
}> = ({ entryId, captionService, initialCaptions, isVideoImported, onAttachToClip }) => {
  const [captions, setCaptions] = useState<KalturaCaptionAsset[]>(initialCaptions);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    setIsLoading(true);
    setError(null);
    captionService
      .listCaptions(entryId)
      .then(setCaptions)
      .catch((err) => {
        setCaptions(initialCaptions);
        setError(getUserMessage(err));
      })
      .finally(() => setIsLoading(false));
  }, [entryId, captionService, initialCaptions]);

  const handleImportSrt = useCallback(
    async (caption: KalturaCaptionAsset) => {
      setBusyId(caption.id);
      setError(null);
      setSuccessMsg(null);
      try {
        const srtContent = await captionService.downloadCaptionAsSrt(caption);
        const fileName = `${caption.label || caption.language}.srt`;

        const fs = require("fs");
        const filePath = `plugin-data:/${fileName}`;
        await fs.writeFile(filePath, srtContent);

        const uxp = require("uxp");
        const fileEntry = await uxp.storage.localFileSystem.getEntryWithUrl(filePath);
        const nativePath = fileEntry.nativePath;

        const ppro = require("premierepro");
        const project = await ppro.Project.getActiveProject();
        await project.importFiles([nativePath], true);
        setSuccessMsg("SRT imported to project panel.");
        setTimeout(() => setSuccessMsg(null), 4000);
      } catch (err) {
        setError(getUserMessage(err));
      } finally {
        setBusyId(null);
      }
    },
    [captionService],
  );

  const handleAttachToClip = useCallback(
    async (caption: KalturaCaptionAsset) => {
      if (!onAttachToClip) return;
      if (!isVideoImported) {
        setError("Import the video first before attaching captions.");
        return;
      }
      setBusyId(caption.id);
      setError(null);
      setSuccessMsg(null);
      try {
        const jsonSegments = await captionService.downloadCaptionAsJson(caption.id);
        const segments = captionService.parseKalturaJson(jsonSegments);

        if (segments.length === 0) {
          setError("No transcript segments found in this caption track.");
          return;
        }

        const result = await onAttachToClip(entryId, segments);
        if (result.success) {
          setSuccessMsg("Transcript attached \u2014 open the Transcript panel to view.");
          setTimeout(() => setSuccessMsg(null), 6000);
        } else {
          setError(`Attach failed: ${result.error}. Use "Import SRT" as an alternative.`);
        }
      } catch (err) {
        setError(`Attach failed: ${getUserMessage(err)}. Use "Import SRT" as an alternative.`);
      } finally {
        setBusyId(null);
      }
    },
    [captionService, entryId, isVideoImported, onAttachToClip],
  );

  if (isLoading) {
    return <LoadingSpinner label="Loading captions..." size="small" />;
  }

  return (
    <div style={{ padding: "0 8px" }}>
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      {successMsg && (
        <div
          className="import-banner import-banner--success"
          style={{ marginBottom: 8, padding: "4px 8px", fontSize: 10 }}
        >
          {successMsg}
        </div>
      )}

      <div className="flex-col gap-8">
        {captions.map((caption) => (
          <div key={caption.id} className="card-item">
            <div className="card-item-header">
              <div>
                <strong>
                  {caption.language.toUpperCase()} — {caption.label}
                </strong>
                {caption.isDefault && (
                  <span className="text-success" style={{ marginLeft: 4, fontSize: 10 }}>
                    Default
                  </span>
                )}
              </div>
            </div>
            <div className="text-muted" style={{ marginTop: 2 }}>
              {formatCaptionFormat(caption.format)} {"\u00B7"} {formatDate(caption.createdAt)}
              {caption.accuracy && ` \u00B7 ${caption.accuracy}% accuracy`}
            </div>
            <div style={{ display: "flex", marginTop: 4 }}>
              <div
                role="button"
                tabIndex={0}
                className="detail-btn detail-btn--secondary"
                style={{ padding: "2px 8px", fontSize: 10, marginRight: 6 }}
                onClick={() => handleImportSrt(caption)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") handleImportSrt(caption);
                }}
              >
                {busyId === caption.id ? "Working..." : "Import SRT"}
              </div>
              {onAttachToClip && isVideoImported && (
                <div
                  role="button"
                  tabIndex={0}
                  className="detail-btn"
                  style={{ padding: "2px 8px", fontSize: 10 }}
                  onClick={() => handleAttachToClip(caption)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") handleAttachToClip(caption);
                  }}
                >
                  {busyId === caption.id ? "Working..." : "Attach to Clip"}
                </div>
              )}
            </div>
          </div>
        ))}

        {captions.length === 0 && (
          <div
            className="text-muted-light"
            style={{ padding: 16, textAlign: "center", fontSize: 11 }}
          >
            No caption tracks available for this entry.
          </div>
        )}
      </div>
    </div>
  );
};
