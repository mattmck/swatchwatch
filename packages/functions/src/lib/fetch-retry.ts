/**
 * Bounded retries for idempotent HTTP reads (catalog image downloads, blob GETs).
 *
 * undici reports connection-level failures as a bare `TypeError: fetch failed` with the real
 * reason (ECONNRESET, ETIMEDOUT, UND_ERR_SOCKET, ...) on `err.cause`; those, plus 429 and 5xx
 * responses, are retried with a short backoff. Other 4xx responses are returned at once.
 */

export const FETCH_RETRY_DEFAULTS = {
  attempts: 3,
  baseDelayMs: 500,
  /** Upper bound for any single wait, including a server-sent Retry-After. */
  maxDelayMs: 10_000,
} as const;

const RETRYABLE_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
]);

export interface FetchRetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Label used in retry log lines. */
  label?: string;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
}

function errorCode(value: unknown): string | null {
  if (value && typeof value === "object" && "code" in value) {
    const code = (value as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

/** True for transient network failures worth retrying (checks the error and its `cause` chain). */
export function isRetryableNetworkError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    const code = errorCode(current);
    if (code && (RETRYABLE_ERROR_CODES.has(code) || code.startsWith("UND_ERR_"))) {
      return true;
    }
    if (current instanceof TypeError && current.message === "fetch failed") {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/** Retry-After as milliseconds (delta-seconds or HTTP date), or null when absent/invalid. */
export function parseRetryAfterMs(value: string | null, now: number = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

/**
 * One-line error description that keeps undici's hidden cause, e.g.
 * `TypeError: fetch failed (ECONNRESET: read ECONNRESET)`.
 */
export function describeFetchError(error: unknown): string {
  const base = String(error);
  const cause = error && typeof error === "object" ? (error as { cause?: unknown }).cause : undefined;
  if (!cause) return base;
  const code = errorCode(cause);
  const message = cause instanceof Error ? cause.message : String(cause);
  const detail = code && !message.includes(code) ? `${code}: ${message}` : message;
  return detail ? `${base} (${detail})` : base;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Call `doFetch` up to `attempts` times. Retries on retryable network errors and 429/5xx
 * responses (the discarded body is cancelled); waits `baseDelayMs * 2^n` between attempts, or the
 * response's Retry-After, capped at `maxDelayMs`. Returns the last response (callers still check
 * `ok`) or rethrows the last error.
 */
export async function fetchWithRetry(
  doFetch: () => Promise<Response>,
  options: FetchRetryOptions = {}
): Promise<Response> {
  const attempts = Math.max(1, Math.floor(options.attempts ?? FETCH_RETRY_DEFAULTS.attempts));
  const baseDelayMs = options.baseDelayMs ?? FETCH_RETRY_DEFAULTS.baseDelayMs;
  const maxDelayMs = options.maxDelayMs ?? FETCH_RETRY_DEFAULTS.maxDelayMs;
  const sleep = options.sleep ?? defaultSleep;
  const label = options.label ?? "fetch";

  for (let attempt = 1; ; attempt++) {
    let delayMs = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
    let reason: string;
    try {
      const response = await doFetch();
      if (attempt >= attempts || !isRetryableStatus(response.status)) {
        return response;
      }
      const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
      if (retryAfterMs !== null) {
        delayMs = Math.min(maxDelayMs, retryAfterMs);
      }
      await response.body?.cancel().catch(() => undefined);
      reason = `HTTP ${response.status}`;
    } catch (error) {
      if (attempt >= attempts || !isRetryableNetworkError(error)) {
        throw error;
      }
      reason = describeFetchError(error);
    }
    console.warn(`[fetch-retry] ${label} attempt ${attempt}/${attempts} failed (${reason}); retrying in ${delayMs}ms`);
    await sleep(delayMs);
  }
}
