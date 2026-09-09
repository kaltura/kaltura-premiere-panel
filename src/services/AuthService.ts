import { KalturaClient } from "./KalturaClient";
import {
  KalturaSessionType,
  KalturaUser,
  KalturaLoginCredentials,
  KalturaAppTokenCredentials,
} from "../types/kaltura";
import { AuthenticationError } from "../utils/errors";
import {
  SESSION_REFRESH_THRESHOLD,
  SECURE_STORAGE_KEY_KS,
  SECURE_STORAGE_KEY_USER,
  SSO_CALLBACK_URL,
  AUTH_BROKER_DEFAULT_REGION,
  SSO_APP_TYPE,
} from "../utils/constants";
import { createLogger } from "../utils/logger";

const log = createLogger("AuthService");

/**
 * UXP SecureStorage raw interface.
 * IMPORTANT: UXP secureStorage.getItem returns Uint8Array, not string.
 * And setItem expects a string value which it stores as bytes internally.
 * We wrap it to handle the Uint8Array ↔ string conversion.
 */
interface SecureStorageRaw {
  getItem(key: string): Promise<Uint8Array | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/** Wrapped SecureStorage that handles UXP's Uint8Array returns */
interface SecureStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/** Get UXP SecureStorage — returns null if not available (test environment) */
function getSecureStorage(): SecureStorage | null {
  try {
    const uxp = require("uxp");
    const raw = uxp.storage.secureStorage as SecureStorageRaw;
    if (!raw) return null;

    // Wrap to handle Uint8Array ↔ string conversion
    return {
      async getItem(key: string): Promise<string | null> {
        try {
          const value = await raw.getItem(key);
          if (value == null) return null;
          // UXP returns Uint8Array — decode to string
          // Note: TextDecoder is not available in UXP, use manual conversion
          if (value instanceof Uint8Array) {
            let str = "";
            for (let i = 0; i < value.length; i++) str += String.fromCharCode(value[i]);
            return str;
          }
          // Some UXP versions may return string directly
          if (typeof value === "string") return value;
          return String(value);
        } catch {
          // UXP secureStorage can throw "Failed to getItem" if storage
          // is not yet initialized or was corrupted — treat as empty
          return null;
        }
      },
      async setItem(key: string, value: string): Promise<void> {
        await raw.setItem(key, value);
      },
      async removeItem(key: string): Promise<void> {
        await raw.removeItem(key);
      },
    };
  } catch {
    return null;
  }
}

export interface AuthSession {
  ks: string;
  user: KalturaUser;
  expiry: number;
  partnerId: number;
  /** Server URL this session was authenticated against — restored on relaunch */
  serverUrl: string;
  /** How this session was created — affects whether auto-refresh is possible */
  authMethod?: "credentials" | "appToken" | "sso";
}

/**
 * Manages Kaltura authentication: login, session persistence, and auto-refresh.
 */
export class AuthService {
  private client: KalturaClient;
  private session: AuthSession | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(client: KalturaClient) {
    this.client = client;
  }

  /** Get the current session (null if not authenticated) */
  getSession(): AuthSession | null {
    return this.session;
  }

  /** Check if the user is currently authenticated */
  isAuthenticated(): boolean {
    return this.session !== null && this.session.expiry > Date.now() / 1000;
  }

  /**
   * Login with email and password.
   */
  async loginWithCredentials(credentials: KalturaLoginCredentials): Promise<AuthSession> {
    log.info("Logging in with email/password");

    try {
      const ksResponse = await this.client.request<
        { objectType?: string } & Record<string, unknown>
      >({
        service: "user",
        action: "loginByLoginId",
        params: {
          loginId: credentials.email,
          password: credentials.password,
          partnerId: credentials.partnerId,
          privileges: "disableentitlement",
        },
      });

      // loginByLoginId returns a raw string KS, wrapped in a response
      const ks = typeof ksResponse === "string" ? ksResponse : String(ksResponse);
      this.client.setKs(ks);

      const user = await this.fetchUserInfo();
      const session: AuthSession = {
        ks,
        user,
        expiry: Date.now() / 1000 + 86400,
        partnerId: credentials.partnerId,
        serverUrl: this.client.getServiceUrl(),
        authMethod: "credentials",
      };

      await this.setSession(session);
      return session;
    } catch (error) {
      if (error instanceof Error && error.message.includes("LOGIN_DATA_NOT_FOUND")) {
        throw new AuthenticationError("Invalid email or password", "AUTH_INVALID_CREDENTIALS");
      }
      throw error;
    }
  }

  /**
   * Login with an app token (preferred for production).
   * tokenHash = SHA256(widgetKS + appToken.token)
   */
  async loginWithAppToken(credentials: KalturaAppTokenCredentials): Promise<AuthSession> {
    log.info("Logging in with app token");

    // First get a widget KS (no auth needed)
    const widgetResult = await this.client.request<
      { objectType?: string; ks?: string } & Record<string, unknown>
    >({
      service: "session",
      action: "startWidgetSession",
      params: {
        widgetId: `_${this.client.getPartnerId()}`,
      },
    });

    const widgetKs = widgetResult.ks as string;
    this.client.setKs(widgetKs);

    // Compute token hash: SHA256(widgetKs + appToken)
    const hashInput = widgetKs + credentials.appToken;
    const tokenHash = await this.sha256(hashInput);

    const response = await this.client.request<
      { objectType?: string; ks?: string } & Record<string, unknown>
    >({
      service: "appToken",
      action: "startSession",
      params: {
        id: credentials.appTokenId,
        tokenHash,
        userId: credentials.userId,
        type: credentials.sessionType ?? KalturaSessionType.USER,
        expiry: 86400,
        sessionPrivileges: "disableentitlement",
      },
    });

    const ks = response.ks as string;
    this.client.setKs(ks);

    const user = await this.fetchUserInfo();
    const session: AuthSession = {
      ks,
      user,
      expiry: Date.now() / 1000 + 86400,
      partnerId: this.client.getPartnerId(),
      serverUrl: this.client.getServiceUrl(),
      authMethod: "appToken",
    };

    await this.setSession(session);
    return session;
  }

  /**
   * Initiate SSO login via Auth Broker (SPA Proxy flow).
   *
   * Opens the system browser to the SSO callback page which handles:
   * 1. Calling the SPA Proxy with the user's email
   * 2. Redirecting to the customer's IdP
   * 3. Receiving the KS back from Auth Broker
   * 4. Displaying it for the user to copy/paste back into the plugin
   */
  initiateSso(
    email: string,
    region: string = AUTH_BROKER_DEFAULT_REGION,
    organizationId?: string,
  ): void {
    log.info("Initiating SSO via Auth Broker", { email, region, organizationId });

    const callbackUrl = new URL(SSO_CALLBACK_URL);
    callbackUrl.searchParams.set("action", "login");
    callbackUrl.searchParams.set("email", email);
    callbackUrl.searchParams.set("appType", SSO_APP_TYPE);
    callbackUrl.searchParams.set("region", region);
    if (organizationId) {
      callbackUrl.searchParams.set("organizationId", organizationId);
    }

    const url = callbackUrl.toString();
    try {
      const uxp = require("uxp");
      uxp.shell.openExternal(url);
    } catch {
      window.open(url, "_blank");
    }
  }

  /**
   * Complete SSO login by validating a pasted KS token.
   * Extracts partnerId from the KS structure (base64: hash|pid;pid;expiry;...).
   */
  async validateSsoToken(ks: string, serverUrl: string): Promise<AuthSession> {
    log.info("Validating SSO token");

    const ksFields = this.parseKsFields(ks);
    this.client.configure({ serviceUrl: serverUrl, partnerId: ksFields.partnerId });
    this.client.setKs(ks);

    try {
      const user = await this.fetchUserInfo();
      // Use expiry from KS if available; fall back to 24h from now
      const expiry = ksFields.expiry > 0 ? ksFields.expiry : Date.now() / 1000 + 86400;
      const session: AuthSession = {
        ks,
        user,
        expiry,
        partnerId: user.partnerId ?? ksFields.partnerId,
        serverUrl,
        authMethod: "sso",
      };
      await this.setSession(session);
      log.info("SSO token validated, login complete");
      return session;
    } catch (error) {
      this.client.setKs(null);
      if (error instanceof Error && error.message.includes("INVALID_KS")) {
        throw new AuthenticationError(
          "Invalid or expired token. Please authenticate again.",
          "SSO_INVALID_TOKEN",
        );
      }
      if (error instanceof AuthenticationError) throw error;
      throw new AuthenticationError(
        "Token validation failed. Please try again.",
        "SSO_VALIDATION_FAILED",
      );
    }
  }

  /** Parse KS fields: hash|partnerId;partnerId;expiry;type;timestamp;... */
  private parseKsFields(ks: string): { partnerId: number; expiry: number } {
    try {
      const normalized = ks.replace(/-/g, "+").replace(/_/g, "/");
      const decoded = atob(normalized);
      const pipeIdx = decoded.indexOf("|");
      if (pipeIdx === -1) return { partnerId: 0, expiry: 0 };
      const fields = decoded.substring(pipeIdx + 1).split(";");
      // fields: [partnerId, partnerId, expiry, type, timestamp, ...]
      const partnerId = parseInt(fields[0], 10) || 0;
      const expiry = parseInt(fields[2], 10) || 0;
      return { partnerId, expiry };
    } catch {
      return { partnerId: 0, expiry: 0 };
    }
  }

  private extractPartnerIdFromKs(ks: string): number {
    return this.parseKsFields(ks).partnerId;
  }

  /**
   * Restore session from secure storage (called on panel launch).
   * Returns null if no stored session or if expired.
   */
  async restoreSession(): Promise<AuthSession | null> {
    const storage = getSecureStorage();
    if (!storage) return null;

    try {
      const storedKs = await storage.getItem(SECURE_STORAGE_KEY_KS);
      const storedUser = await storage.getItem(SECURE_STORAGE_KEY_USER);

      log.info("Restore session: stored data", {
        hasKs: !!storedKs,
        ksLength: storedKs?.length ?? 0,
        hasUser: !!storedUser,
        userLength: storedUser?.length ?? 0,
      });

      if (!storedKs || !storedUser) return null;

      const userInfo = JSON.parse(storedUser) as AuthSession;

      // Check if expired
      if (userInfo.expiry < Date.now() / 1000) {
        log.info("Stored session expired, clearing");
        await this.clearSession();
        return null;
      }

      this.client.setKs(storedKs);

      // Restore partnerId and serverUrl on the client so API calls target the
      // same server this session was authenticated against
      if (userInfo.partnerId) {
        this.client.configure({ partnerId: userInfo.partnerId });
      }
      if (userInfo.serverUrl) {
        this.client.configure({ serviceUrl: userInfo.serverUrl });
      }

      // Validate the session is still active
      try {
        const user = await this.fetchUserInfo();
        const session: AuthSession = {
          ks: storedKs,
          user,
          expiry: userInfo.expiry,
          partnerId: userInfo.partnerId,
          serverUrl: userInfo.serverUrl ?? this.client.getServiceUrl(),
        };
        this.session = session;
        this.scheduleRefresh();
        log.info("Session restored successfully");
        return session;
      } catch {
        log.warn("Stored session invalid, clearing");
        await this.clearSession();
        return null;
      }
    } catch (error) {
      log.warn("Failed to restore session (clearing corrupt data)", error);
      await this.clearSession();
      return null;
    }
  }

  /** Logout: clear session and storage */
  async logout(): Promise<void> {
    log.info("Logging out");
    this.client.setKs(null);
    this.session = null;
    this.cancelRefresh();
    await this.clearSession();
  }

  private async fetchUserInfo(): Promise<KalturaUser> {
    return this.client.request<KalturaUser>({
      service: "user",
      action: "get",
    });
  }

  private async setSession(session: AuthSession): Promise<void> {
    this.session = session;
    this.scheduleRefresh();

    const storage = getSecureStorage();
    if (storage) {
      await storage.setItem(SECURE_STORAGE_KEY_KS, session.ks);
      await storage.setItem(SECURE_STORAGE_KEY_USER, JSON.stringify(session));
    }
  }

  private async clearSession(): Promise<void> {
    const storage = getSecureStorage();
    if (storage) {
      await storage.removeItem(SECURE_STORAGE_KEY_KS);
      await storage.removeItem(SECURE_STORAGE_KEY_USER);
    }
  }

  private scheduleRefresh(): void {
    this.cancelRefresh();
    if (!this.session) return;

    // SSO sessions cannot be refreshed — they require re-authentication via the IdP
    if (this.session.authMethod === "sso") return;

    const ttlSeconds = this.session.expiry - Date.now() / 1000;
    const refreshInMs = ttlSeconds * SESSION_REFRESH_THRESHOLD * 1000;

    if (refreshInMs > 0) {
      this.refreshTimer = setTimeout(() => this.refreshSession(), refreshInMs);
      log.debug(`Session refresh scheduled in ${Math.round(refreshInMs / 1000)}s`);
    }
  }

  private cancelRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private async refreshSession(): Promise<void> {
    if (!this.session) return;

    log.info("Refreshing session");
    try {
      const response = await this.client.request<
        { objectType?: string; ks?: string } & Record<string, unknown>
      >({
        service: "session",
        action: "start",
        params: {
          partnerId: this.session.partnerId,
          type: KalturaSessionType.USER,
          expiry: 86400,
          privileges: "disableentitlement",
        },
      });

      const ks = response.ks ?? (typeof response === "string" ? response : null);
      if (ks) {
        this.session.ks = ks as string;
        this.session.expiry = Date.now() / 1000 + 86400;
        this.client.setKs(ks as string);
        await this.setSession(this.session);
        log.info("Session refreshed successfully");
      }
    } catch (error) {
      log.error("Session refresh failed", error);
    }
  }

  private async sha256(input: string): Promise<string> {
    // Manual string-to-bytes (UXP does not support TextEncoder)
    const data = new Uint8Array(input.length);
    for (let i = 0; i < input.length; i++) data[i] = input.charCodeAt(i);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  }
}
