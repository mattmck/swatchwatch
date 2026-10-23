import type { CaptureCheckResponse, CaptureFrameType, CaptureStartResponse } from "swatchwatch-shared";

/** Missing or invalid runner configuration (the CLI exits 1 before doing any work). */
export class EvalConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalConfigError";
  }
}

/** A capture API call that did not return 2xx. */
export class CaptureApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "CaptureApiError";
  }
}

/** The three capture calls the runner makes. `check` is read-only; `finalize` is never called. */
export interface CaptureApi {
  /** API base URL without a trailing slash (e.g. `http://localhost:7071/api`). */
  readonly baseUrl: string;
  /** Authenticated `GET {baseUrl}/{path}`; resolves to the HTTP status (the body is discarded). */
  getStatus(path: string): Promise<number>;
  start(meta: Record<string, unknown>): Promise<string>;
  frame(
    id: string,
    body: { imageBlobUrl: string; frameType: CaptureFrameType; quality: Record<string, unknown> }
  ): Promise<void>;
  check(id: string): Promise<CaptureCheckResponse>;
}

/** Per-call timeout: frames can run OCR and AI extraction. */
const CALL_TIMEOUT_MS = 120_000;
const REACHABILITY_TIMEOUT_MS = 10_000;

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  // fetch() reports "fetch failed" and keeps the reason (ECONNREFUSED, ENOTFOUND…) in `cause`.
  const cause = (error as { cause?: { code?: unknown; message?: unknown } }).cause;
  const detail = typeof cause?.code === "string" ? cause.code : typeof cause?.message === "string" ? cause.message : "";
  return detail ? `${error.message} (${detail})` : error.message;
}

/** HTTP client for `POST capture/start`, `capture/{id}/frame` and `capture/{id}/check`, as the admin. */
export function createCaptureApi(baseUrl: string, bearer: string): CaptureApi {
  const base = (baseUrl ?? "").trim().replace(/\/+$/, "");
  const token = (bearer ?? "").trim();
  if (!base) throw new EvalConfigError("API_BASE_URL is empty");
  if (!token) {
    throw new EvalConfigError("ADMIN_BEARER_TOKEN is required (an admin token, or dev:<adminId> locally)");
  }
  try {
    new URL(base);
  } catch {
    throw new EvalConfigError(`API_BASE_URL is not a URL: ${base}`);
  }

  async function post<T>(path: string, body: unknown): Promise<T> {
    const url = `${base}/${path}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new CaptureApiError(
        `POST ${url} → ${response.status} ${response.statusText} ${text.slice(0, 300)}`.trim(),
        response.status
      );
    }
    try {
      return (text ? JSON.parse(text) : {}) as T;
    } catch {
      throw new CaptureApiError(`POST ${url} returned invalid JSON`, response.status);
    }
  }

  return {
    baseUrl: base,
    async getStatus(path) {
      const response = await fetch(`${base}/${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(REACHABILITY_TIMEOUT_MS),
      });
      await response.body?.cancel().catch(() => undefined);
      return response.status;
    },
    async start(meta) {
      const response = await post<CaptureStartResponse>("capture/start", { metadata: meta });
      if (typeof response.captureId !== "string" || !response.captureId) {
        throw new CaptureApiError("capture/start returned no captureId", 200);
      }
      return response.captureId;
    },
    async frame(id, body) {
      await post(`capture/${encodeURIComponent(id)}/frame`, body);
    },
    async check(id) {
      return post<CaptureCheckResponse>(`capture/${encodeURIComponent(id)}/check`, {});
    },
  };
}

/** `GET {baseUrl}/reference/finishes` must answer 200; otherwise throws an error naming the URL. */
export async function assertApiReachable(api: CaptureApi): Promise<void> {
  const url = `${api.baseUrl}/reference/finishes`;
  let status: number;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(REACHABILITY_TIMEOUT_MS) });
    status = response.status;
    await response.body?.cancel().catch(() => undefined);
  } catch (error) {
    throw new EvalConfigError(`API not reachable at ${url}: ${errorMessage(error)}`);
  }
  if (status !== 200) {
    throw new EvalConfigError(`API not reachable at ${url}: HTTP ${status}`);
  }
}

/**
 * One authenticated admin-only request (`GET {baseUrl}/bottle-eval-admin/samples?limit=1`) so a
 * wrong or non-admin `ADMIN_BEARER_TOKEN` stops the run before any sample is loaded or any report
 * written: 401 or 403 throws an `EvalConfigError` naming the status.
 */
export async function assertAdminToken(api: CaptureApi): Promise<void> {
  const url = `${api.baseUrl}/bottle-eval-admin/samples?limit=1`;
  let status: number;
  try {
    status = await api.getStatus("bottle-eval-admin/samples?limit=1");
  } catch (error) {
    throw new EvalConfigError(`Admin token check failed at ${url}: ${errorMessage(error)}`);
  }
  if (status === 401 || status === 403) {
    throw new EvalConfigError(
      `Admin token check at ${url} answered HTTP ${status}: ADMIN_BEARER_TOKEN must be an admin token (or dev:<adminId> locally)`
    );
  }
}
