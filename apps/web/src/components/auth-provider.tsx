"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { MsalProvider } from "@azure/msal-react";
import { PublicClientApplication, EventType } from "@azure/msal-browser";
import {
  buildApiTokenScopes,
  buildLoginRequestScopes,
  buildMsalConfig,
  buildPolicyQueryParameters,
  buildSilentRedirectUri,
} from "@/lib/msal-config";
import { setAccessToken, setAccessTokenProvider } from "@/lib/auth-token";
import { claimTokenRedirect, createAccessTokenProvider } from "@/lib/token-renewal";

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
    let redirecting = false;

    // Every API call gets its token here (see getAuthHeaders in api.ts). acquireTokenSilent
    // returns the cached token, or renews it when it is within 5 minutes of expiry. A failed
    // renewal of any kind sends the user to sign-in rather than leaving the app on 401s.
    const getToken = createAccessTokenProvider({
      acquireSilent: async () => {
        const account = msalInstance.getActiveAccount();
        const scopes = buildApiTokenScopes();
        if (!account || scopes.length === 0) {
          return null;
        }
        const result = await msalInstance.acquireTokenSilent({
          scopes,
          account,
          // A bridge page, not the app root, so the hidden renewal iframe never mounts the app.
          redirectUri: buildSilentRedirectUri(),
          extraQueryParameters: buildPolicyQueryParameters(),
        });
        return result.accessToken || null;
      },
      acquireInteractive: async () => {
        redirecting = true;
        await msalInstance.acquireTokenRedirect({
          scopes: buildLoginRequestScopes(),
          extraQueryParameters: buildPolicyQueryParameters(),
        });
      },
      claimRedirect: () => {
        try {
          return claimTokenRedirect(window.sessionStorage, Date.now());
        } catch {
          return true;
        }
      },
      onError: (error) => console.warn("[Auth] token acquisition failed", error),
    });

    const init = async () => {
      await msalInstance.initialize();

      // Handle redirect response if returning from B2C
      const response = await msalInstance.handleRedirectPromise();
      if (response?.accessToken) {
        setAccessToken(response.accessToken);
      }

      // MSAL's silent renew loads its redirect URI in a hidden iframe. That is the bridge page
      // (buildSilentRedirectUri), but if the app root is ever loaded there, running the rest of
      // the app would call acquireTokenSilent while the response hash is present, which MSAL
      // rejects with block_iframe_reload, and would mount the dashboard, telemetry and API
      // calls inside the iframe. Stop here.
      if (window.self !== window.top) {
        setIsInitialized(true);
        return;
      }

      // Set active account if one exists
      const accounts = msalInstance.getAllAccounts();
      if (accounts.length > 0 && !msalInstance.getActiveAccount()) {
        msalInstance.setActiveAccount(accounts[0]);
      }

      setAccessTokenProvider(getToken);
      await getToken();
      if (redirecting) {
        return;
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

  // Inside MSAL's silent-renew iframe, render nothing (see init above).
  const inSilentRenewFrame = typeof window !== "undefined" && window.self !== window.top;
  if (!isInitialized || inSilentRenewFrame) {
    return null;
  }

  return <MsalProvider instance={msalInstance}>{children}</MsalProvider>;
}
