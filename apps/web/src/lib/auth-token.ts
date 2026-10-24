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
// Notified whenever the stored token or the offline flag changes, so the auth guard re-renders
// when a token lands after its last render instead of showing the sign-in card for good.
const _listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [..._listeners]) listener();
}

function storeToken(token: string | null): void {
  const changed = token !== _accessToken;
  _accessToken = token;
  if (changed) notify();
}

/** Subscribes to token and offline-flag changes (`useSyncExternalStore` shape); returns the unsubscribe. */
export function subscribeAccessToken(listener: () => void): () => void {
  _listeners.add(listener);
  return () => {
    _listeners.delete(listener);
  };
}

export function setAccessToken(token: string | null): void {
  _accessTokenGeneration += 1;
  storeToken(token);
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
  storeToken(token);
  return _accessToken;
}

// True while the last silent renewal failed only because the network is unreachable. The auth
// guard then keeps the app open (saved copies, read-only) instead of asking for a sign-in.
let _authOffline = false;

export function setAuthOffline(offline: boolean): void {
  const changed = offline !== _authOffline;
  _authOffline = offline;
  if (changed) notify();
}

/** What the auth guard needs: a stored API token, or an offline session that may open saved copies. */
export function hasUsableAccessToken(): boolean {
  return _accessToken !== null || _authOffline;
}

export function isAuthOffline(): boolean {
  return _authOffline;
}
