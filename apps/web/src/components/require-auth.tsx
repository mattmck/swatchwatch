"use client";

import { type ReactNode } from "react";
import { useIsAuthenticated, useMsal } from "@azure/msal-react";
import {
  buildLoginRequestScopes,
  buildMsalConfig,
  buildPolicyQueryParameters,
} from "@/lib/msal-config";
import { Button } from "@/components/ui/button";

const IS_DEV_BYPASS = process.env.NEXT_PUBLIC_AUTH_DEV_BYPASS === "true";

export function RequireAuth({ children }: { children: ReactNode }) {
  if (IS_DEV_BYPASS) {
    return <>{children}</>;
  }

  // If B2C is not configured, MsalProvider was never rendered, so we can't use MSAL hooks
  if (!buildMsalConfig()) {
    return <UnconfiguredNotice />;
  }

  return <B2CGuard>{children}</B2CGuard>;
}

/**
 * Shown when B2C is not configured (no env vars).
 * This allows the app to load and marketing pages to work,
 * but protected routes will show this notice.
 */
function UnconfiguredNotice() {
  console.warn(
    "[Auth] B2C is not configured. Protected routes require NEXT_PUBLIC_B2C_TENANT and NEXT_PUBLIC_B2C_CLIENT_ID."
  );
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="space-y-4 text-center">
        <h1 className="text-2xl font-bold">Authentication Not Configured</h1>
        <p className="text-muted-foreground">
          This route requires authentication, but B2C is not configured.
        </p>
      </div>
    </div>
  );
}

/**
 * Only rendered when B2C is active — safe to call MSAL hooks.
 */
function B2CGuard({ children }: { children: ReactNode }) {
  const isAuthenticated = useIsAuthenticated();
  const { instance } = useMsal();

  if (isAuthenticated) {
    return <>{children}</>;
  }

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="space-y-4 text-center">
        <h1 className="text-2xl font-bold">Sign in to SwatchWatch</h1>
        <p className="text-muted-foreground">
          You need to sign in to access your collection.
        </p>
        <Button
          variant="brand"
          onClick={() =>
            instance.loginRedirect({
              scopes: buildLoginRequestScopes(),
              extraQueryParameters: buildPolicyQueryParameters(),
            })}
        >
          Sign In
        </Button>
      </div>
    </div>
  );
}
