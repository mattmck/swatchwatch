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
import {
  getFreshAccessToken,
  setAccessToken,
  setAccessTokenProvider,
  setAuthOffline,
} from "@/lib/auth-token";
import { clearApiCache, setApiCacheUser } from "@/lib/api-cache";
import { isOfflineRenewalFailure } from "@/lib/offline";
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
        try {
          await msalInstance.acquireTokenRedirect({
            scopes: buildLoginRequestScopes(),
            extraQueryParameters: buildPolicyQueryParameters(),
          });
        } catch (error) {
          // No navigation happened (e.g. interaction_in_progress): let init finish rendering.
          redirecting = false;
          throw error;
        }
      },
      claimRedirect: () => {
        try {
          return claimTokenRedirect(window.sessionStorage, Date.now());
        } catch {
          return true;
        }
      },
      onError: (error) => console.warn("[Auth] token acquisition failed", error),
      // A network failure is not a bad session: stay on the page (saved copies, read-only).
      isOfflineFailure: (error) => isOfflineRenewalFailure(error),
      onOffline: setAuthOffline,
    });

    // Back online: renew now so the app is usable again without a reload.
    const handleOnline = () => {
      void getToken();
    };
    window.addEventListener("online", handleOnline);

    const init = async () => {
      await msalInstance.initialize();

      // Handle redirect response if returning from B2C
      const response = await msalInstance.handleRedirectPromise();
      if (response?.accessToken) {
        setAccessToken(response.accessToken);
      }
      // The account that just signed in becomes the active one. The active account persists in
      // localStorage, so without this a stale cached account (expired refresh token) stays
      // active, every silent renewal fails for it, and the app keeps bouncing through sign-in.
      if (response?.account) {
        msalInstance.setActiveAccount(response.account);
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
      // Saved copies of the collection belong to this account (opaque id, never the email).
      const activeAccount = msalInstance.getActiveAccount();
      if (activeAccount) {
        setApiCacheUser(activeAccount.homeAccountId);
      }

      setAccessTokenProvider(getToken);
      // Store the token before the app renders: the auth guard reads it on its first render, and
      // the ACQUIRE_TOKEN_SUCCESS listener below is not registered yet to catch this call.
      await getFreshAccessToken();
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
            const signedIn = payload.account as Parameters<typeof msalInstance.setActiveAccount>[0];
            msalInstance.setActiveAccount(signedIn);
            if (signedIn?.homeAccountId) {
              setApiCacheUser(signedIn.homeAccountId);
            }
          }
        }
        if (event.eventType === EventType.LOGOUT_SUCCESS) {
          setAccessToken(null);
          clearApiCache();
        }
      });

      setIsInitialized(true);
    };

    init().catch((err) => {
      console.error("MSAL initialization failed:", err);
      setIsInitialized(true); // Unblock rendering even on error
    });
    return () => window.removeEventListener("online", handleOnline);
  }, [msalInstance]);

  // Inside MSAL's silent-renew iframe, render nothing (see init above).
  const inSilentRenewFrame = typeof window !== "undefined" && window.self !== window.top;
  if (!isInitialized || inSilentRenewFrame) {
    return null;
  }

  return <MsalProvider instance={msalInstance}>{children}</MsalProvider>;
}
