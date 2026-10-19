import { refreshAsync, TokenError, type TokenResponse } from "expo-auth-session";
import { AUTH_MODE, DEV_USER_ID } from "@/config/env";
import { saveStoredAuth, type StoredTokens } from "./token-store";

/**
 * Module-level token holder, the mobile twin of `apps/web/src/lib/auth-token.ts`: the auth
 * provider sets it, the API client reads it through `getAuthorizationHeader()`.
 */

interface RefreshConfig {
  clientId: string;
  tokenEndpoint: string;
  scopes: string[];
  extraParams?: Record<string, string>;
}

let tokens: StoredTokens | null = null;
let refreshConfig: RefreshConfig | null = null;
let refreshing: Promise<StoredTokens | null> | null = null;
let devSignedIn = false;
let sessionExpiredHandler: (() => void) | null = null;

/** The auth provider registers this to send the user back to sign-in. */
export function setSessionExpiredHandler(handler: (() => void) | null): void {
  sessionExpiredHandler = handler;
}

/** The session can't be used any more (refresh token rejected, or the API answered 401). */
export function notifySessionExpired(): void {
  sessionExpiredHandler?.();
}

/** Refresh this many seconds before expiry so a request never carries a stale token. */
const EXPIRY_SKEW_SECONDS = 60;

export function setTokens(next: StoredTokens | null, config?: RefreshConfig | null): void {
  tokens = next;
  if (config !== undefined) refreshConfig = config;
}

export function getTokens(): StoredTokens | null {
  return tokens;
}

export function setDevSignedIn(value: boolean): void {
  devSignedIn = value;
}

export function tokensFromResponse(response: TokenResponse, previous?: StoredTokens | null): StoredTokens {
  return {
    accessToken: response.accessToken,
    expiresAt: response.expiresIn ? response.issuedAt + response.expiresIn : undefined,
    // Entra may omit a rotated refresh token; keep the previous one then.
    refreshToken: response.refreshToken ?? previous?.refreshToken,
    idToken: response.idToken ?? previous?.idToken,
  };
}

export function isExpired(stored: StoredTokens, nowSeconds = Date.now() / 1000): boolean {
  return stored.expiresAt !== undefined && stored.expiresAt - EXPIRY_SKEW_SECONDS <= nowSeconds;
}

/**
 * Refresh the access token with the stored refresh token (single flight). Resolves null when
 * the token endpoint rejects the refresh token (e.g. `invalid_grant`: the session is over);
 * rejects on network/transport errors so a temporary outage never discards a valid session.
 */
export async function refreshTokens(): Promise<StoredTokens | null> {
  const current = tokens;
  const config = refreshConfig;
  if (!current?.refreshToken || !config) return null;
  if (!refreshing) {
    refreshing = refreshAsync(
      {
        clientId: config.clientId,
        refreshToken: current.refreshToken,
        scopes: config.scopes,
        extraParams: config.extraParams,
      },
      { tokenEndpoint: config.tokenEndpoint },
    )
      .then(async (response) => {
        const next = tokensFromResponse(response, current);
        tokens = next;
        await saveStoredAuth({ mode: "entra", tokens: next });
        return next;
      })
      .catch((error: unknown) => {
        if (error instanceof TokenError) {
          tokens = null;
          return null;
        }
        throw error;
      })
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

/**
 * The `Authorization` header for API calls, or null when signed out. Dev bypass sends
 * `Bearer dev:<userId>` exactly like the web's `getAuthHeaders()`.
 */
export async function getAuthorizationHeader(): Promise<string | null> {
  if (AUTH_MODE === "dev-bypass") {
    return devSignedIn ? `Bearer dev:${DEV_USER_ID}` : null;
  }
  let current = tokens;
  if (current && isExpired(current)) {
    current = (await refreshTokens()) ?? null;
    if (!current) notifySessionExpired();
  }
  return current ? `Bearer ${current.accessToken}` : null;
}

/** Bearer header for one explicit token (used to validate before the session is stored). */
export function bearerFor(accessToken: string): string {
  return `Bearer ${accessToken}`;
}

export function devBearer(): string {
  return `Bearer dev:${DEV_USER_ID}`;
}
