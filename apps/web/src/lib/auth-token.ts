/**
 * Module-level access token store.
 * The AuthProvider registers a token provider (MSAL silent acquisition with renewal) and
 * `getAuthHeaders()` in api.ts asks it for a fresh token on every API call.
 */
let _accessToken: string | null = null;
let _accessTokenProvider: (() => Promise<string | null>) | null = null;

export function setAccessToken(token: string | null): void {
  _accessToken = token;
}

export function getAccessToken(): string | null {
  return _accessToken;
}

/** Registered by the AuthProvider once MSAL is initialized; null unregisters it. */
export function setAccessTokenProvider(provider: (() => Promise<string | null>) | null): void {
  _accessTokenProvider = provider;
}

/**
 * Token for an API call: from the registered provider, which renews it before it expires, or the
 * last stored token when no provider is registered.
 */
export async function getFreshAccessToken(): Promise<string | null> {
  if (!_accessTokenProvider) {
    return _accessToken;
  }
  _accessToken = await _accessTokenProvider();
  return _accessToken;
}
