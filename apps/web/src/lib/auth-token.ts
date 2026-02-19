/**
 * Module-level access token store.
 * Set by the AuthProvider when MSAL acquires a token.
 * Read by getAuthHeaders() in api.ts.
 */
let _accessToken: string | null = null;

export function setAccessToken(token: string | null): void {
  _accessToken = token;
}

export function getAccessToken(): string | null {
  return _accessToken;
}
