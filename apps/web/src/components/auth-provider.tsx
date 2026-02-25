"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { MsalProvider } from "@azure/msal-react";
import {
  PublicClientApplication,
  EventType,
  InteractionRequiredAuthError,
} from "@azure/msal-browser";
import {
  buildApiTokenScopes,
  buildLoginRequestScopes,
  buildMsalConfig,
  buildPolicyQueryParameters,
} from "@/lib/msal-config";
import { setAccessToken } from "@/lib/auth-token";

const TOKEN_REDIRECT_GUARD_KEY = "swatchwatch:token-redirect-at";
const TOKEN_REDIRECT_GUARD_WINDOW_MS = 30_000;

export function AuthProvider({ children }: { children: ReactNode }) {
  const msalConfig = useMemo(() => buildMsalConfig(), []);

  // No B2C config -> dev bypass or unconfigured mode. Render children directly.
  if (!msalConfig) {
    return <>{children}</>;
  }

  return <MsalAuthProvider config={msalConfig}>{children}</MsalAuthProvider>;
}

/**
 * Inner component that is ONLY rendered when MSAL is configured.
 * MSAL hooks can only be used inside <MsalProvider>, so by splitting
 * this into a separate component we guarantee hooks are never called
 * without a provider ancestor.
 */
function MsalAuthProvider({
  config,
  children,
}: {
  config: NonNullable<ReturnType<typeof buildMsalConfig>>;
  children: ReactNode;
}) {
  const msalInstance = useMemo(
    () => new PublicClientApplication(config),
    [config],
  );

  const [isInitialized, setIsInitialized] = useState(false);

  useEffect(() => {
    const maybeAcquireTokenInteractively = async () => {
      if (typeof window === "undefined") {
        return;
      }
      const now = Date.now();
      const lastAttemptRaw = window.sessionStorage.getItem(TOKEN_REDIRECT_GUARD_KEY);
      const lastAttempt = lastAttemptRaw ? Number(lastAttemptRaw) : 0;
      if (Number.isFinite(lastAttempt) && now - lastAttempt < TOKEN_REDIRECT_GUARD_WINDOW_MS) {
        return;
      }

      window.sessionStorage.setItem(TOKEN_REDIRECT_GUARD_KEY, String(now));
      await msalInstance.acquireTokenRedirect({
        scopes: buildLoginRequestScopes(),
        extraQueryParameters: buildPolicyQueryParameters(),
      });
    };

    const init = async () => {
      await msalInstance.initialize();

      // Handle redirect response if returning from B2C
      const response = await msalInstance.handleRedirectPromise();
      if (response?.accessToken) {
        setAccessToken(response.accessToken);
      }

      // Set active account if one exists
      const accounts = msalInstance.getAllAccounts();
      if (accounts.length > 0 && !msalInstance.getActiveAccount()) {
        msalInstance.setActiveAccount(accounts[0]);
      }

      // Acquire token silently for the active account
      const activeAccount = msalInstance.getActiveAccount();
      const apiTokenScopes = buildApiTokenScopes();
      if (activeAccount) {
        if (apiTokenScopes.length === 0) {
          setAccessToken(null);
        } else {
          try {
            const result = await msalInstance.acquireTokenSilent({
              scopes: apiTokenScopes,
              account: activeAccount,
              extraQueryParameters: buildPolicyQueryParameters(),
            });
            setAccessToken(result.accessToken);
          } catch (error) {
            // Silent token acquisition commonly fails when an interaction is required.
            // Do not continue with null tokens forever (causes repeating 401s).
            setAccessToken(null);
            console.warn("[Auth] acquireTokenSilent failed", error);
            if (error instanceof InteractionRequiredAuthError) {
              await maybeAcquireTokenInteractively();
              return;
            }
          }
        }
      }

      // Listen for future token events
      msalInstance.addEventCallback((event) => {
        if (
          event.eventType === EventType.LOGIN_SUCCESS ||
          event.eventType === EventType.ACQUIRE_TOKEN_SUCCESS
        ) {
          const payload = event.payload as {
            accessToken?: string;
            account?: unknown;
          } | null;
          if (payload?.accessToken) {
            setAccessToken(payload.accessToken);
          }
          if (payload?.account) {
            msalInstance.setActiveAccount(
              payload.account as Parameters<
                typeof msalInstance.setActiveAccount
              >[0],
            );
          }
        }
        if (event.eventType === EventType.LOGOUT_SUCCESS) {
          setAccessToken(null);
        }
      });

      setIsInitialized(true);
    };

    init().catch((err) => {
      console.error("MSAL initialization failed:", err);
      setIsInitialized(true); // Unblock rendering even on error
    });
  }, [msalInstance]);

  if (!isInitialized) {
    return null;
  }

  return <MsalProvider instance={msalInstance}>{children}</MsalProvider>;
}
