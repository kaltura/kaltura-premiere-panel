import React, { useState, useCallback } from "react";
import { KalturaLoginCredentials } from "../types";
import { ErrorBanner, LoadingSpinner } from "../components";
import { DEFAULT_SERVICE_URL, KALTURA_REGIONS, PLUGIN_NAME } from "../utils/constants";
import { useTranslation } from "../i18n";

interface LoginPanelProps {
  onLogin: (credentials: KalturaLoginCredentials) => Promise<void>;
  onSsoInitiate?: (email: string, region?: string, organizationId?: string) => void;
  onSsoComplete?: (ks: string, serverUrl: string) => Promise<void>;
  onCancelSso?: () => void;
  ssoWaitingForToken?: boolean;
  onServerUrlChange?: (url: string) => void;
  isLoading: boolean;
  error: string | null;
  onClearError: () => void;
}

export const LoginPanel: React.FC<LoginPanelProps> = ({
  onLogin,
  onSsoInitiate,
  onSsoComplete,
  onCancelSso,
  ssoWaitingForToken,
  onServerUrlChange,
  isLoading,
  error,
  onClearError,
}) => {
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [partnerId, setPartnerId] = useState("");
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVICE_URL);
  const [region, setRegion] = useState<string>(
    () => KALTURA_REGIONS.find((r) => r.serviceUrl === DEFAULT_SERVICE_URL)?.code ?? "custom",
  );
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [authMode, setAuthMode] = useState<"email" | "sso">("email");
  const [ssoToken, setSsoToken] = useState("");
  const [organizationId, setOrganizationId] = useState("");

  const handleServerUrlChange = useCallback(
    (url: string) => {
      setServerUrl(url);
      onServerUrlChange?.(url);
    },
    [onServerUrlChange],
  );

  const handleRegionChange = useCallback(
    (code: string) => {
      setRegion(code);
      const found = KALTURA_REGIONS.find((r) => r.code === code);
      if (found) handleServerUrlChange(found.serviceUrl);
    },
    [handleServerUrlChange],
  );

  const handleSubmit = useCallback(async () => {
    if (!email || !password || !partnerId) return;
    onClearError();
    await onLogin({
      email,
      password,
      partnerId: parseInt(partnerId, 10),
    });
  }, [email, password, partnerId, onLogin, onClearError]);

  const handleSsoInitiate = useCallback(() => {
    if (!email || !onSsoInitiate) return;
    onClearError();
    onSsoInitiate(email, undefined, organizationId || undefined);
  }, [email, organizationId, onSsoInitiate, onClearError]);

  const handleSsoComplete = useCallback(async () => {
    if (!ssoToken || !onSsoComplete) return;
    onClearError();
    await onSsoComplete(ssoToken.trim(), serverUrl);
  }, [ssoToken, serverUrl, onSsoComplete, onClearError]);

  const handleReopenBrowser = useCallback(() => {
    if (!email || !onSsoInitiate) return;
    onSsoInitiate(email, undefined, organizationId || undefined);
  }, [email, organizationId, onSsoInitiate]);

  const handleForgotPassword = useCallback(() => {
    const url = `${serverUrl}/index.php/kmcng/login`;
    if (!/^https:\/\//i.test(url)) return;
    try {
      const uxp = require("uxp");
      uxp.shell.openExternal(url);
    } catch {
      window.open(url, "_blank");
    }
  }, [serverUrl]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") handleSubmit();
    },
    [handleSubmit],
  );

  const isFormValid = email.length > 0 && password.length > 0 && partnerId.length > 0;

  if (isLoading) {
    return (
      <div className="login-container">
        <LoadingSpinner label={t("login.signingIn")} size="large" />
      </div>
    );
  }

  return (
    <div className="login-container">
      <div className="login-brand">
        <img src="icons/kaltura-sun-color.svg" alt="Kaltura" className="login-logo-img" />
        <sp-heading size="M">{PLUGIN_NAME}</sp-heading>
        <div className="login-divider" />
      </div>
      <div className="login-subtitle">{t("login.subtitle")}</div>

      {error && <ErrorBanner message={error} onDismiss={onClearError} />}

      <div className="login-form">
        {/* Auth mode toggle */}
        {onSsoInitiate && (
          <div className="login-toggle">
            <div
              role="button"
              tabIndex={0}
              className={`login-toggle-btn${authMode === "email" ? " login-toggle-btn--active" : ""}`}
              onClick={() => setAuthMode("email")}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") setAuthMode("email");
              }}
            >
              {t("login.tabEmail")}
            </div>
            <div
              role="button"
              tabIndex={0}
              className={`login-toggle-btn${authMode === "sso" ? " login-toggle-btn--active" : ""}`}
              onClick={() => setAuthMode("sso")}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") setAuthMode("sso");
              }}
            >
              {t("login.tabSSO")}
            </div>
          </div>
        )}

        {authMode === "email" ? (
          <>
            <sp-textfield
              placeholder={t("login.emailPlaceholder")}
              aria-label={t("login.emailAriaLabel")}
              value={email}
              onInput={(e: Event) => setEmail((e.target as HTMLInputElement).value)}
              onKeyDown={handleKeyDown}
              style={{ width: "100%" }}
              type="email"
            />
            <sp-textfield
              placeholder={t("login.passwordPlaceholder")}
              aria-label={t("login.passwordAriaLabel")}
              value={password}
              onInput={(e: Event) => setPassword((e.target as HTMLInputElement).value)}
              onKeyDown={handleKeyDown}
              style={{ width: "100%" }}
              type="password"
            />
            <sp-textfield
              placeholder={t("login.partnerIdPlaceholder")}
              aria-label={t("login.partnerIdAriaLabel")}
              value={partnerId}
              onInput={(e: Event) => {
                const val = (e.target as HTMLInputElement).value.replace(/\D/g, "");
                setPartnerId(val);
              }}
              onKeyDown={handleKeyDown}
              style={{ width: "100%" }}
            />
            <div
              role="button"
              tabIndex={isFormValid ? 0 : -1}
              className={`btn-kaltura${!isFormValid ? " btn-kaltura--disabled" : ""}`}
              onClick={isFormValid ? handleSubmit : undefined}
              onKeyDown={(e) => {
                if (isFormValid && (e.key === "Enter" || e.key === " ")) handleSubmit();
              }}
              aria-disabled={!isFormValid || undefined}
            >
              {t("login.signIn")}
            </div>
          </>
        ) : ssoWaitingForToken ? (
          <>
            <div className="login-sso-info">{t("login.ssoTokenInfo")}</div>
            <sp-textfield
              placeholder={t("login.ssoTokenPlaceholder")}
              aria-label={t("login.ssoTokenAriaLabel")}
              value={ssoToken}
              onInput={(e: Event) => setSsoToken((e.target as HTMLInputElement).value)}
              onKeyDown={(e: React.KeyboardEvent) => {
                if (e.key === "Enter") handleSsoComplete();
              }}
              style={{ width: "100%" }}
              type="password"
            />
            <div
              role="button"
              tabIndex={ssoToken.trim() ? 0 : -1}
              className={`btn-kaltura${!ssoToken.trim() ? " btn-kaltura--disabled" : ""}`}
              onClick={ssoToken.trim() ? handleSsoComplete : undefined}
              onKeyDown={(e) => {
                if (ssoToken.trim() && (e.key === "Enter" || e.key === " ")) handleSsoComplete();
              }}
              aria-disabled={!ssoToken.trim() || undefined}
            >
              {t("login.completeLogin")}
            </div>
            <div className="login-links">
              <sp-action-button quiet size="s" onClick={handleReopenBrowser}>
                {t("login.reopenBrowser")}
              </sp-action-button>
              <sp-action-button quiet size="s" onClick={onCancelSso}>
                {t("login.cancel")}
              </sp-action-button>
            </div>
          </>
        ) : (
          <>
            <sp-textfield
              placeholder={t("login.ssoEmailPlaceholder")}
              aria-label={t("login.emailAriaLabel")}
              value={email}
              onInput={(e: Event) => setEmail((e.target as HTMLInputElement).value)}
              onKeyDown={(e: React.KeyboardEvent) => {
                if (e.key === "Enter") handleSsoInitiate();
              }}
              style={{ width: "100%" }}
              type="email"
            />
            <sp-textfield
              placeholder={t("login.organizationIdPlaceholder")}
              aria-label={t("login.organizationIdAriaLabel")}
              value={organizationId}
              onInput={(e: Event) => setOrganizationId((e.target as HTMLInputElement).value)}
              onKeyDown={(e: React.KeyboardEvent) => {
                if (e.key === "Enter") handleSsoInitiate();
              }}
              style={{ width: "100%" }}
            />
            <div
              role="button"
              tabIndex={email ? 0 : -1}
              className={`btn-kaltura${!email ? " btn-kaltura--disabled" : ""}`}
              onClick={email ? handleSsoInitiate : undefined}
              onKeyDown={(e) => {
                if (email && (e.key === "Enter" || e.key === " ")) handleSsoInitiate();
              }}
              aria-disabled={!email || undefined}
            >
              {t("login.signInSSO")}
            </div>
          </>
        )}

        {authMode === "email" && (
          <div className="login-links">
            <sp-action-button quiet size="s" onClick={handleForgotPassword}>
              {t("login.forgotPassword")}
            </sp-action-button>

            <sp-action-button quiet size="s" onClick={() => setShowAdvanced(!showAdvanced)}>
              {showAdvanced ? t("login.hideServer") : t("login.configureServer")}
            </sp-action-button>
          </div>
        )}

        {showAdvanced && authMode === "email" && (
          <>
            <select
              className="native-select"
              aria-label={t("login.regionAriaLabel")}
              value={region}
              onChange={(e) => handleRegionChange(e.target.value)}
              style={{ width: "100%" }}
            >
              {KALTURA_REGIONS.map((r) => (
                <option key={r.code} value={r.code}>
                  {t(`login.region.${r.code}`)}
                </option>
              ))}
              <option value="custom">{t("login.region.custom")}</option>
            </select>
            {region === "custom" && (
              <sp-textfield
                placeholder={t("login.serverUrlPlaceholder")}
                aria-label={t("login.serverUrlAriaLabel")}
                value={serverUrl}
                onInput={(e: Event) => handleServerUrlChange((e.target as HTMLInputElement).value)}
                style={{ width: "100%" }}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
};
