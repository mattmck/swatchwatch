"use client";

import { useEffect, type ReactNode } from "react";
import { useIsAuthenticated, useMsal } from "@azure/msal-react";
import { buildMsalConfig } from "@/lib/msal-config";
import { clearUser, initTelemetry, isTelemetryEnabled, setUser } from "@/lib/telemetry";

const IS_DEV_BYPASS = process.env.NEXT_PUBLIC_AUTH_DEV_BYPASS === "true";
const HAS_B2C_CONFIG = buildMsalConfig() !== null;

/**
 * Starts browser telemetry after hydration and tags it with the signed-in
 * user's internal id. Must sit inside `AuthProvider`. Renders nothing extra
 * and does nothing when telemetry is off.
 */
export function TelemetryProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    void initTelemetry();
  }, []);

  return (
    <>
      {isTelemetryEnabled() &&
        (IS_DEV_BYPASS ? (
          <TelemetryUser accountKey="dev-bypass" />
        ) : HAS_B2C_CONFIG ? (
          <MsalTelemetryUser />
        ) : null)}
      {children}
    </>
  );
}

/** Only rendered when B2C is configured, so MSAL hooks have a provider. */
function MsalTelemetryUser() {
  const isAuthenticated = useIsAuthenticated();
  const { accounts } = useMsal();
  const accountKey = isAuthenticated ? (accounts[0]?.homeAccountId ?? null) : null;
  return <TelemetryUser accountKey={accountKey} />;
}

/**
 * Resolves the internal user id (the MSAL account only has the B2C subject and
 * email) once per signed-in account. Clears the previous id on every account
 * change, so a switch or a failed lookup never keeps the old user's id.
 */
function TelemetryUser({ accountKey }: { accountKey: string | null }) {
  useEffect(() => {
    clearUser();
    if (!accountKey) return;

    let cancelled = false;
    import("@/lib/api")
      .then(({ getCurrentUserId }) => getCurrentUserId())
      .then((userId) => {
        if (!cancelled && userId !== null) setUser(String(userId));
      })
      .catch(() => {
        // Untagged telemetry is better than a broken page.
      });

    return () => {
      cancelled = true;
    };
  }, [accountKey]);

  return null;
}
