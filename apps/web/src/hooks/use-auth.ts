"use client";

import { useMsal, useIsAuthenticated } from "@azure/msal-react";
import {
  buildLoginRequestScopes,
  buildPolicyQueryParameters,
} from "@/lib/msal-config";

export interface AuthUser {
  name: string;
  email?: string;
}

export interface UseAuthReturn {
  isAuthenticated: boolean;
  user: AuthUser | null;
  role: "admin" | "user" | null;
  isAdmin: boolean;
  login: () => void;
  logout: () => void;
}

/**
 * Auth hook for B2C mode.
 * Only call this from components that are guaranteed to be rendered
 * within <MsalProvider> (i.e., when B2C is configured).
 */
export function useAuth(): UseAuthReturn {
  const { instance, accounts } = useMsal();
  const isAuthenticated = useIsAuthenticated();

  const account = accounts[0] ?? null;
  const roleClaimsRaw = (account?.idTokenClaims as { roles?: string[] | string } | undefined)?.roles;
  const roleClaims = Array.isArray(roleClaimsRaw)
    ? roleClaimsRaw
    : typeof roleClaimsRaw === "string"
      ? [roleClaimsRaw]
      : [];
  const isAdmin = roleClaims.some((role) => role.toLowerCase() === "admin");
  const role: "admin" | "user" = isAdmin ? "admin" : "user";

  const user: AuthUser | null = account
    ? {
        name: account.name || account.username || "User",
        email: account.username || undefined,
      }
    : null;

  const login = () => {
    instance.loginRedirect({
      scopes: buildLoginRequestScopes(),
      extraQueryParameters: buildPolicyQueryParameters(),
    });
  };

  const logout = () => {
    instance.logoutRedirect();
  };

  return { isAuthenticated, user, role, isAdmin, login, logout };
}

/**
 * Stub auth state for unconfigured B2C mode (B2C vars not set).
 * No MSAL hooks — safe to call anywhere.
 */
export function useUnconfiguredAuth(): UseAuthReturn {
  return {
    isAuthenticated: false,
    user: null,
    role: null,
    isAdmin: false,
    login: () => {
      console.warn("[Auth] Cannot login: B2C is not configured");
    },
    logout: () => {},
  };
}

/**
 * Stub auth state for dev bypass mode.
 * No MSAL hooks — safe to call anywhere.
 */
export function useDevAuth(): UseAuthReturn {
  return {
    isAuthenticated: true,
    user: { name: "Dev User", email: "dev@swatchwatch.app" },
    role: "admin",
    isAdmin: true,
    login: () => {},
    logout: () => {},
  };
}
