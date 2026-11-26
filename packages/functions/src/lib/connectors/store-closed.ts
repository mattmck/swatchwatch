/**
 * A store that has locked itself (Shopify storefront password page, Big Cartel maintenance
 * mode) is not an ingestion failure: the job ends `succeeded` with stage `store_closed`, the
 * catalog stays untouched and the next run tries again (#529). Connectors throw
 * `StoreClosedError` only on these exact signals and never try to get past the lock; any other
 * 401/403 (a Cloudflare challenge, a WAF block) stays a normal failure.
 */

/** Why a store counts as closed. */
export type StoreClosedReason =
  /** Shopify: the catalog request answered 401, or was redirected to `/password`. */
  | "password_page"
  /** Big Cartel: the API answered 403 with a JSON `reason` about maintenance. */
  | "maintenance";

export interface StoreClosedDetails {
  source: string;
  reason: StoreClosedReason;
  /** HTTP status of the response that showed the lock (the redirect's final status for `/password`). */
  httpStatus: number | null;
  /** The request URL that showed the lock. */
  url: string;
  /** Short vendor text explaining the lock (e.g. Big Cartel's `reason`), when there is one. */
  detail?: string | null;
}

/** Thrown by a connector when the store is closed or locked; the worker turns it into `store_closed`. */
export class StoreClosedError extends Error {
  readonly source: string;
  readonly reason: StoreClosedReason;
  readonly httpStatus: number | null;
  readonly url: string;
  readonly detail: string | null;

  constructor(details: StoreClosedDetails) {
    const what =
      details.reason === "password_page"
        ? "is password-protected (storefront password page)"
        : "is under maintenance";
    const status = details.httpStatus === null ? "" : ` (HTTP ${details.httpStatus})`;
    const detail = details.detail ? `: ${details.detail}` : "";
    super(`${details.source} store ${what}${status}${detail}`);
    this.name = "StoreClosedError";
    this.source = details.source;
    this.reason = details.reason;
    this.httpStatus = details.httpStatus;
    this.url = details.url;
    this.detail = details.detail ?? null;
  }
}

/** True for a `StoreClosedError`, also across duplicate module instances (checked by name and shape). */
export function isStoreClosedError(error: unknown): error is StoreClosedError {
  if (error instanceof StoreClosedError) return true;
  if (!(error instanceof Error) || error.name !== "StoreClosedError") return false;
  const reason = (error as Partial<StoreClosedError>).reason;
  return reason === "password_page" || reason === "maintenance";
}

/** The response fields the Shopify check reads (a `fetch` Response satisfies it). */
export interface StoreClosedResponseLike {
  status: number;
  /** Final URL after redirects (`Response.url`). */
  url?: string;
  redirected?: boolean;
  headers?: { get(name: string): string | null } | null;
}

/**
 * Cancels a response body the caller will not read (a password page, a 401), so undici frees the
 * connection now instead of holding it until the body is garbage-collected. Never throws.
 */
export async function releaseResponseBody(response: { body?: { cancel(): Promise<void> } | null }): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Already consumed, locked or errored: nothing left to release.
  }
}

/** True when Cloudflare answered with a challenge (bot check); never treated as a closed store. */
export function isCloudflareChallenge(response: Pick<StoreClosedResponseLike, "headers">): boolean {
  const mitigated = response.headers?.get("cf-mitigated");
  return typeof mitigated === "string" && mitigated.trim().toLowerCase() === "challenge";
}

function redirectedToPasswordPage(response: StoreClosedResponseLike): boolean {
  if (!response.url) return false;
  try {
    const path = new URL(response.url).pathname.replace(/\/+$/, "");
    return path === "/password";
  } catch {
    return false;
  }
}

/**
 * Shopify-style catalog request: a storefront password lock answers `/products.json` with 401,
 * or redirects it to `/password`. Returns null for anything else (a Cloudflare challenge
 * included), which the connector reports as an ordinary failure.
 */
export function detectShopifyStoreClosed(response: StoreClosedResponseLike): StoreClosedReason | null {
  if (isCloudflareChallenge(response)) return null;
  if (redirectedToPasswordPage(response)) return "password_page";
  if (response.status === 401) return "password_page";
  return null;
}

/**
 * Big Cartel v0 API: a store in maintenance mode answers 403 with `{"reason":"Store is under
 * maintenance"}`. Returns the vendor's reason text when it says so, else null (an HTML 403 from
 * a WAF or a challenge stays a failure).
 */
export function detectBigCartelMaintenance(status: number, body: string): string | null {
  if (status !== 403 || !body) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const reason = (parsed as Record<string, unknown>).reason;
  if (typeof reason !== "string" || !/maintenance/i.test(reason)) return null;
  const text = reason.replace(/\s+/g, " ").trim();
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}
