"use client";

import { type ReactNode } from "react";
import { useIsAuthenticated, useMsal } from "@azure/msal-react";
import { LOGIN_SCOPES } from "@/lib/msal-config";
import { Button } from "@/components/ui/button";

const IS_DEV_BYPASS = process.env.NEXT_PUBLIC_AUTH_DEV_BYPASS === "true";

export function RequireAuth({ children }: { children: ReactNode }) {
  if (IS_DEV_BYPASS) {
    return <>{children}</>;
  }

  return <B2CGuard>{children}</B2CGuard>;
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
          onClick={() => instance.loginRedirect({ scopes: LOGIN_SCOPES })}
        >
          Sign In
        </Button>
      </div>
    </div>
  );
}
