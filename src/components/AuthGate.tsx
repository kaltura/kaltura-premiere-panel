/**
 * AuthGate — shared auth wrapper for all panels.
 *
 * Shows the LoginPanel when not authenticated; renders children when
 * authenticated. Uses the singleton services so login from any panel
 * authenticates all panels.
 */
import React, { useEffect, useCallback } from "react";
import { useAuth } from "../hooks";
import { KalturaLoginCredentials } from "../types";
import { LoginPanel } from "../panels/LoginPanel";
import { StatusBar } from "./StatusBar";
import { LoadingSpinner } from "./LoadingSpinner";
import { client, authService, auditService, hostService } from "../services/singleton";
import { AUTH_SIGNIN_EVENT } from "../utils/constants";

interface AuthGateProps {
  panelTitle?: string;
  children: (ctx: AuthGateContext) => React.ReactNode;
}

export interface AuthGateContext {
  partnerId: number;
  userId: string | undefined;
  userName: string | null;
  userEmail: string | null;
  serverUrl: string;
}

export const AuthGate: React.FC<AuthGateProps> = ({ panelTitle, children }) => {
  const { authState, login, loginWithSso, cancelSso, isLoading, error, clearError } = useAuth(
    client,
    authService,
  );

  // Configure client when auth changes
  useEffect(() => {
    if (authState.partnerId) {
      client.configure({ partnerId: authState.partnerId });
    }
  }, [authState.partnerId]);

  // Sync with project on auth (including session restore)
  useEffect(() => {
    if (authState.isAuthenticated) {
      hostService.syncWithProject?.();
    }
  }, [authState.isAuthenticated]);

  // Wrap login to log audit trail and notify other panels
  const handleLogin = useCallback(
    async (credentials: KalturaLoginCredentials) => {
      await login(credentials);
      auditService.logAction("login", undefined, `User: ${credentials.email}`);
      document.dispatchEvent(new Event(AUTH_SIGNIN_EVENT));
    },
    [login],
  );

  const handleSsoLogin = useCallback(
    async (serverUrl: string, partnerId: number) => {
      await loginWithSso(serverUrl, partnerId);
      auditService.logAction("login", undefined, "SSO login");
      document.dispatchEvent(new Event(AUTH_SIGNIN_EVENT));
    },
    [loginWithSso],
  );

  const handleServerUrlChange = useCallback((url: string) => {
    client.configure({ serviceUrl: url });
  }, []);

  // Loading state during session restore
  if (isLoading && !authState.isAuthenticated) {
    return (
      <div className="panel-root">
        <LoadingSpinner label="Loading..." size="large" />
        <StatusBar connectionState={authState.connectionState} />
      </div>
    );
  }

  // Unauthenticated — show login
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
            onLogin={handleLogin}
            onSsoLogin={handleSsoLogin}
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

  // Authenticated — render panel content
  return (
    <div className="panel-root">
      {panelTitle && (
        <div
          style={{
            padding: "6px 12px",
            fontSize: 11,
            fontWeight: 600,
            color: "#999",
            letterSpacing: "0.5px",
            textTransform: "uppercase" as const,
            borderBottom: "1px solid #333",
            flexShrink: 0,
          }}
        >
          {panelTitle}
        </div>
      )}
      {children({
        partnerId: authState.partnerId!,
        userId: authState.user?.id,
        userName: authState.user?.fullName ?? null,
        userEmail: authState.user?.email ?? null,
        serverUrl: authState.serverUrl,
      })}
      <StatusBar connectionState={authState.connectionState} />
    </div>
  );
};
