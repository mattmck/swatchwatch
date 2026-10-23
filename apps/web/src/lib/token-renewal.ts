/**
 * API access-token renewal, kept free of MSAL imports so it can be unit-tested.
 *
 * `auth-provider.tsx` wires it to MSAL: every API call asks for a token through the provider,
 * MSAL's `acquireTokenSilent` returns the cached token or renews it once it is within
 * `tokenRenewalOffsetSeconds` (300 s) of expiry, and any silent failure (interaction required,
 * expired refresh token, hidden-iframe errors such as `block_iframe_reload`, timeouts) sends the
 * user to an interactive sign-in instead of letting the app call the API without a token.
 */

export const TOKEN_REDIRECT_GUARD_KEY = "swatchwatch:token-redirect-at";
export const TOKEN_REDIRECT_GUARD_WINDOW_MS = 30_000;

/**
 * Records an interactive token redirect in `storage` and returns true, or returns false when one
 * already started within the guard window, so a sign-in that keeps failing cannot loop.
 */
export function claimTokenRedirect(
  storage: Pick<Storage, "getItem" | "setItem">,
  now: number,
): boolean {
  const raw = storage.getItem(TOKEN_REDIRECT_GUARD_KEY);
  const lastAttempt = raw === null ? Number.NaN : Number(raw);
  if (Number.isFinite(lastAttempt) && now - lastAttempt < TOKEN_REDIRECT_GUARD_WINDOW_MS) {
    return false;
  }
  storage.setItem(TOKEN_REDIRECT_GUARD_KEY, String(now));
  return true;
}

export interface AccessTokenProviderDeps {
  /** Silent acquisition: a valid token, or null when nobody is signed in. Throws when renewal fails. */
  acquireSilent: () => Promise<string | null>;
  /** Interactive sign-in (navigates away from the page). */
  acquireInteractive: () => Promise<void>;
  /** Redirect loop guard, see `claimTokenRedirect`. */
  claimRedirect: () => boolean;
  onError?: (error: unknown) => void;
}

/**
 * Returns a function that resolves to a fresh access token, or null when there is none (signed out,
 * or renewal failed and the user is being sent to sign-in). Concurrent calls share one acquisition.
 */
export function createAccessTokenProvider(deps: AccessTokenProviderDeps): () => Promise<string | null> {
  let inFlight: Promise<string | null> | null = null;

  const acquire = async (): Promise<string | null> => {
    try {
      return await deps.acquireSilent();
    } catch (error) {
      deps.onError?.(error);
      if (deps.claimRedirect()) {
        try {
          await deps.acquireInteractive();
        } catch (redirectError) {
          deps.onError?.(redirectError);
        }
      }
      return null;
    }
  };

  return () => {
    if (!inFlight) {
      inFlight = acquire().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  };
}
