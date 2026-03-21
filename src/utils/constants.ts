/** Plugin identity */
export const PLUGIN_ID = "com.kaltura.premiere.panel";
export const PLUGIN_NAME = "Kaltura";
export const PLUGIN_VERSION = "1.18.0";
export const CLIENT_TAG = `kaltura-premiere-panel:v${PLUGIN_VERSION}`;

/** Default Kaltura service URL */
export const DEFAULT_SERVICE_URL = "https://www.kaltura.com";

/** API paths */
export const API_BASE_PATH = "/api_v3/service";

/** Thumbnail CDN base URL */
export const THUMBNAIL_CDN_URL = "https://cdnsecakmi.kaltura.com";

/** Pagination */
export const DEFAULT_PAGE_SIZE = 50;
export const SEARCH_DEBOUNCE_MS = 300;
export const INFINITE_SCROLL_THRESHOLD_PX = 200;

/** Upload */
export const UPLOAD_CHUNK_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB
export const MAX_CONCURRENT_DOWNLOADS = 2;

/** Cache */
export const DEFAULT_CACHE_SIZE_MB = 500;
export const THUMBNAIL_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
export const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
export const SESSION_REFRESH_THRESHOLD = 0.8; // Refresh at 80% of TTL

/** Timeouts */
export const API_TIMEOUT_MS = 30_000;
export const UPLOAD_TIMEOUT_MS = 600_000; // 10 minutes per chunk
export const WEBSOCKET_RECONNECT_BASE_MS = 1_000;
export const WEBSOCKET_RECONNECT_MAX_MS = 30_000;
export const SSO_POLL_INTERVAL_MS = 2_000;
export const SSO_TIMEOUT_MS = 300_000; // 5 minutes

/** Governance */
export const CONTENT_HOLD_TAG = "content_hold";
export const HOLD_REASON_PREFIX = "hold_reason:";
export const LICENSE_EXPIRY_WARNING_DAYS = 7;
export const LICENSE_EXPIRY_WARNING_SECONDS = LICENSE_EXPIRY_WARNING_DAYS * 24 * 60 * 60;

/** Resolution thresholds for quality labels */
export const RESOLUTION_FULL_HD = 1080;
export const RESOLUTION_HD = 720;
export const RESOLUTION_SD = 480;

/** Premiere panel */
export const KALTURA_BIN_NAME = "Kaltura Assets";
/** Thumbnail URL construction */
export const THUMBNAIL_GRID_WIDTH = 200;
export const THUMBNAIL_GRID_HEIGHT = 120;
export const THUMBNAIL_GRID_QUALITY = 75;

/** Cross-panel auth events */
export const AUTH_SIGNIN_EVENT = "kaltura:signin";
export const AUTH_SIGNOUT_EVENT = "kaltura:signout";

/** Support */
export const ISSUES_URL = "https://github.com/zoharbabin/kaltura-premiere-panel/issues";

/** Storage keys */
export const STORAGE_KEY_CONFIG = "kaltura_config";
export const STORAGE_KEY_SETTINGS = "kaltura_settings";
export const STORAGE_KEY_ASSET_MAPPINGS = "kaltura_asset_mappings";
export const SECURE_STORAGE_KEY_KS = "kaltura_ks";
export const SECURE_STORAGE_KEY_USER = "kaltura_user";
