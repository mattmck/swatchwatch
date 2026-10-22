/**
 * Module-level access token store.
 * The AuthProvider registers a token provider (MSAL silent acquisition with renewal) and
 * `getAuthHeaders()` in api.ts asks it for a fresh token on every API call.
 */
let _accessToken: string | null = null;
let _accessTokenProvider: (() => Promise<string | null>) | null = null;
// Bumped on every store change so a provider call that settles afterwards (e.g. after sign-out
// cleared the token) cannot write its stale result back.
let _accessTokenGeneration = 0;

export function setAccessToken(token: string | null): void {
  _accessTokenGeneration += 1;
  _accessToken = token;
}

export function getAccessToken(): string | null {
  return _accessToken;
}

/** Registered by the AuthProvider once MSAL is initialized; null unregisters it. */
export function setAccessTokenProvider(provider: (() => Promise<string | null>) | null): void {
  _accessTokenGeneration += 1;
  _accessTokenProvider = provider;
}

/**
 * Token for an API call: from the registered provider, which renews it before it expires, or the
 * last stored token when no provider is registered. A result that settles after the store changed
 * is discarded: the current token is returned instead (null if the provider was replaced).
 */
export async function getFreshAccessToken(): Promise<string | null> {
  const provider = _accessTokenProvider;
  if (!provider) {
    return _accessToken;
  }
  const generation = _accessTokenGeneration;
  const token = await provider();
  if (generation !== _accessTokenGeneration || provider !== _accessTokenProvider) {
    return provider === _accessTokenProvider ? _accessToken : null;
  }
  _accessToken = token;
  return _accessToken;
}
