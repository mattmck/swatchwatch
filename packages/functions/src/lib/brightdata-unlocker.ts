/**
 * Bright Data Web Unlocker transport (`data_source.metadata.fetchVia = "brightdata-unlocker"`).
 *
 * For a store that put a bot challenge (Cloudflare) in front of its catalog and then allowed us
 * to read it, but cannot allowlist our requests: each GET goes to
 * `POST https://api.brightdata.com/request` with `{ zone, url, format: "raw", method: "GET" }` and
 * the store's own response (status, headers such as `X-WP-TotalPages`, body bytes) comes back as
 * the answer. The target's status is read from `x-brd-status-code` when Bright Data sends it.
 *
 * Configuration: `BRIGHTDATA_API_KEY` (bearer token) and `BRIGHTDATA_UNLOCKER_ZONE` (a Web
 * Unlocker zone). A source that asks for the unlocker fails its pull (or image download) when
 * either is missing, rather than silently falling back to a direct request the challenge blocks.
 * Only ever used for a source whose owner gave written OK, recorded in `metadata.notes`.
 */

/** The `metadata.fetchVia` values a source can name. */
export const FETCH_VIA_VALUES = ["brightdata-unlocker"] as const;
export type FetchVia = (typeof FETCH_VIA_VALUES)[number];

const BRIGHTDATA_REQUEST_URL = "https://api.brightdata.com/request";

/** Reads `metadata.fetchVia`: a known transport name, else null (direct requests). */
export function readFetchVia(value: unknown): FetchVia | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return (FETCH_VIA_VALUES as readonly string[]).includes(normalized) ? (normalized as FetchVia) : null;
}

interface UnlockerConfig {
  apiKey: string;
  zone: string;
}

/** The Web Unlocker key and zone from the environment, or null when either is unset. */
export function readBrightDataUnlockerConfig(env: NodeJS.ProcessEnv = process.env): UnlockerConfig | null {
  const apiKey = env.BRIGHTDATA_API_KEY?.trim();
  const zone = env.BRIGHTDATA_UNLOCKER_ZONE?.trim();
  return apiKey && zone ? { apiKey, zone } : null;
}

export interface UnlockerFetchInit {
  method?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Accepted for fetch compatibility; Bright Data follows redirects itself. */
  redirect?: "manual" | "follow";
}

export interface BrightDataUnlockerFetchOptions {
  env?: NodeJS.ProcessEnv;
  /** Injected in tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * A fetch-compatible GET through the Web Unlocker. Returns a `Response` carrying the store's
 * status (from `x-brd-status-code` when present), its headers and its body. Only GET is
 * supported. Throws when the unlocker is not configured.
 */
export function createBrightDataUnlockerFetch(options: BrightDataUnlockerFetchOptions = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  return async (url: string, init: UnlockerFetchInit = {}): Promise<Response> => {
    const config = readBrightDataUnlockerConfig(options.env ?? process.env);
    if (!config) {
      throw new Error("fetchVia brightdata-unlocker needs BRIGHTDATA_API_KEY and BRIGHTDATA_UNLOCKER_ZONE");
    }
    const method = (init.method ?? "GET").toUpperCase();
    if (method !== "GET") throw new Error(`fetchVia brightdata-unlocker supports GET only, not ${method}`);
    const response = await fetchImpl(BRIGHTDATA_REQUEST_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ zone: config.zone, url, format: "raw", method: "GET" }),
      signal: init.signal,
    });
    const targetStatus = Number.parseInt(response.headers.get("x-brd-status-code") ?? "", 10);
    const status = Number.isInteger(targetStatus) && targetStatus >= 200 && targetStatus <= 599 ? targetStatus : response.status;
    if (status === response.status) return response;
    // A null-body status (204, 304) cannot carry a body in a Response.
    const body = status === 204 || status === 304 ? null : response.body;
    return new Response(body, { status, statusText: response.statusText, headers: response.headers });
  };
}

/** The fetch a source's requests use: the Web Unlocker for `fetchVia`, else the global fetch. */
export function fetchForSource(fetchVia: FetchVia | null): typeof fetch {
  return fetchVia === "brightdata-unlocker"
    ? (createBrightDataUnlockerFetch() as unknown as typeof fetch)
    : globalThis.fetch;
}
