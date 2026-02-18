"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { MsalProvider } from "@azure/msal-react";
import { PublicClientApplication, EventType } from "@azure/msal-browser";
import { buildMsalConfig, LOGIN_SCOPES } from "@/lib/msal-config";
import { setAccessToken } from "@/lib/auth-token";

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
      if (activeAccount) {
        try {
          const result = await msalInstance.acquireTokenSilent({
            scopes: LOGIN_SCOPES,
            account: activeAccount,
          });
          setAccessToken(result.accessToken);
        } catch {
          // Token expired or unavailable — user will need to log in again
          setAccessToken(null);
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
