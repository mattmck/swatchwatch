"use client";

import { useMsal, useIsAuthenticated } from "@azure/msal-react";
import { LOGIN_SCOPES } from "@/lib/msal-config";

export interface AuthUser {
  name: string;
  email?: string;
}

export interface UseAuthReturn {
  isAuthenticated: boolean;
  user: AuthUser | null;
  login: () => void;
  logout: () => void;
}

/**
 * Auth hook for B2C mode. Must ONLY be used inside components
 * rendered within <MsalProvider> (i.e., when B2C auth is active).
 *
 * For dev bypass mode, use useDevAuth() instead.
 */
export function useAuth(): UseAuthReturn {
  const { instance, accounts } = useMsal();
  const isAuthenticated = useIsAuthenticated();

  const account = accounts[0] ?? null;

  const user: AuthUser | null = account
    ? {
        name: account.name || account.username || "User",
        email: account.username || undefined,
      }
    : null;

  const login = () => {
    instance.loginRedirect({ scopes: LOGIN_SCOPES });
  };

  const logout = () => {
    instance.logoutRedirect();
  };

  return { isAuthenticated, user, login, logout };
}

/**
 * Stub auth state for dev bypass mode.
 * No MSAL hooks — safe to call anywhere.
 */
export function useDevAuth(): UseAuthReturn {
  return {
    isAuthenticated: true,
    user: { name: "Dev User", email: "dev@swatchwatch.app" },
    login: () => {},
    logout: () => {},
  };
}
