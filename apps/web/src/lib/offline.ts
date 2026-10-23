/**
 * Offline decisions for the saved-copy feature, kept free of React and MSAL so they can be
 * unit-tested. A "network failure" is the API (or the identity provider) being unreachable,
 * as opposed to the server answering with an error.
 */

/** MSAL error codes that mean the network, not the account, is the problem. */
const MSAL_NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
  "no_network_connectivity",
  "network_error",
  "endpoints_resolution_error",
  "get_request_failed",
  "post_request_failed",
  "failed_to_build_headers",
]);

/** Gateway statuses that mean the API host is down rather than rejecting the request. */
const UNREACHABLE_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

/** Browsers throw `TypeError` from `fetch` when the request never reached a server. */
function isFetchNetworkError(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;
  return /failed to fetch|load failed|network ?error|fetch failed/i.test(error.message);
}

/** `navigator.onLine === false` is reliable only in the negative; true can still be a dead link. */
export function isBrowserOffline(
  nav: { onLine?: boolean } | undefined = typeof navigator === "undefined" ? undefined : navigator,
): boolean {
  return nav?.onLine === false;
}

/**
 * True when an API call failed because the API cannot be reached: a network failure, or a
 * gateway 502/503/504. Anything else (401, 403, 404, 500 ...) is a real answer and not offline.
 */
export function isApiUnreachable(error: unknown, offline: boolean = isBrowserOffline()): boolean {
  if (isFetchNetworkError(error)) return true;
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === "number") return UNREACHABLE_STATUSES.has(status);
  // Any non-HTTP failure while the browser reports no connection is a connection failure.
  return offline;
}

/**
 * True when a failed silent token renewal should NOT send the user to sign-in: the failure is
 * a network problem (the browser is offline, or MSAL/fetch reports one), so the session is
 * still valid and the saved copy can be shown read-only. Online renewal failures (interaction
 * required, expired refresh token, iframe errors) still redirect.
 */
export function isOfflineRenewalFailure(error: unknown, offline: boolean = isBrowserOffline()): boolean {
  if (offline) return true;
  if (isFetchNetworkError(error)) return true;
  const code = (error as { errorCode?: unknown } | null)?.errorCode;
  return typeof code === "string" && MSAL_NETWORK_ERROR_CODES.has(code);
}

export type SavedCopyAge = "lt_1h" | "lt_1d" | "lt_3d" | "lt_7d";

const HOUR_MS = 60 * 60 * 1000;

/** Coarse age of a saved copy for telemetry (never an exact timestamp). */
export function savedCopyAgeBucket(savedAt: number, now: number): SavedCopyAge {
  const age = Math.max(0, now - savedAt);
  if (age < HOUR_MS) return "lt_1h";
  if (age < 24 * HOUR_MS) return "lt_1d";
  if (age < 3 * 24 * HOUR_MS) return "lt_3d";
  return "lt_7d";
}

/** "Mar 4, 2026, 3:12 PM" style label for the banner. */
export function formatSavedAt(savedAt: number): string {
  return new Date(savedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

const shownOfflineKeys = new Set<string>();

/**
 * True the first time `key` is seen this session, so `collection.offline_shown` fires once per
 * saved copy even when the page remounts and shows the same copy again.
 */
export function claimOfflineShown(key: string): boolean {
  if (shownOfflineKeys.has(key)) return false;
  shownOfflineKeys.add(key);
  return true;
}

/** Error text when the API failed and no saved copy exists for the view. */
export function unreachableMessage(what: "view" | "polish", offline: boolean = isBrowserOffline()): string {
  const saved = what === "view" ? "this view hasn't" : "this polish hasn't";
  return offline
    ? `You're offline, and ${saved} been saved on this device.`
    : `SwatchWatch can't be reached right now, and ${saved} been saved on this device.`;
}
