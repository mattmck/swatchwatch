import type {
  BottleEvalFrameAddResponse,
  BottleEvalFrameRequest,
  BottleEvalSampleRequest,
  BottleEvalSampleResponse,
} from "swatchwatch-shared";
import { CaptureApiError, EvalConfigError } from "../api-client";
import type { CatalogHit } from "./layout";

/** The admin API calls `eval:bottle:import` makes. */
export interface ImportApi {
  readonly baseUrl: string;
  /** `GET catalog/search?q=` (anonymous; up to 50 hits). */
  searchCatalog(query: string): Promise<CatalogHit[]>;
  /** `GET catalog/shade/{id}`; `null` on 404. */
  getShade(shadeId: string): Promise<CatalogHit | null>;
  /** Throws an `EvalConfigError` when the token is missing, rejected (401/403) or the API is unreachable. */
  assertAdmin(): Promise<void>;
  createSample(body: BottleEvalSampleRequest): Promise<string>;
  addFrame(sampleId: string, body: BottleEvalFrameRequest): Promise<string>;
}

/** Frame uploads re-encode on the server. */
const CALL_TIMEOUT_MS = 120_000;

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as { cause?: { code?: unknown; message?: unknown } }).cause;
  const detail = typeof cause?.code === "string" ? cause.code : typeof cause?.message === "string" ? cause.message : "";
  return detail ? `${error.message} (${detail})` : error.message;
}

export function createImportApi(baseUrl: string, bearer: string | null): ImportApi {
  const base = (baseUrl ?? "").trim().replace(/\/+$/, "");
  const token = (bearer ?? "").trim();
  if (!base) throw new EvalConfigError("API_BASE_URL is empty");
  try {
    new URL(base);
  } catch {
    throw new EvalConfigError(`API_BASE_URL is not a URL: ${base}`);
  }

  async function send<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const url = `${base}/${path}`;
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch (error) {
      throw new CaptureApiError(`${method} ${url} failed: ${errorMessage(error)}`, 0);
    }
    const text = await response.text();
    if (!response.ok) {
      throw new CaptureApiError(
        `${method} ${url} → ${response.status} ${response.statusText} ${text.slice(0, 300)}`.trim(),
        response.status
      );
    }
    try {
      return (text ? JSON.parse(text) : {}) as T;
    } catch {
      throw new CaptureApiError(`${method} ${url} returned invalid JSON`, response.status);
    }
  }

  const requireToken = () => {
    if (!token) throw new EvalConfigError("ADMIN_BEARER_TOKEN is required (an admin token, or dev:<adminId> locally)");
  };

  return {
    baseUrl: base,
    async searchCatalog(query) {
      const response = await send<{ results?: CatalogHit[] }>("GET", `catalog/search?q=${encodeURIComponent(query)}&limit=50`);
      return (response.results ?? []).map((hit) => ({ shadeId: String(hit.shadeId), brand: hit.brand, name: hit.name }));
    },
    async getShade(shadeId) {
      try {
        const shade = await send<CatalogHit>("GET", `catalog/shade/${encodeURIComponent(shadeId)}`);
        return { shadeId: String(shade.shadeId), brand: shade.brand, name: shade.name };
      } catch (error) {
        if (error instanceof CaptureApiError && error.status === 404) return null;
        throw error;
      }
    },
    async assertAdmin() {
      requireToken();
      const url = `${base}/bottle-eval-admin/samples?limit=1`;
      try {
        await send("GET", "bottle-eval-admin/samples?limit=1");
      } catch (error) {
        if (error instanceof CaptureApiError && (error.status === 401 || error.status === 403)) {
          throw new EvalConfigError(
            `Admin token check at ${url} answered HTTP ${error.status}: ADMIN_BEARER_TOKEN must be an admin token (or dev:<adminId> locally)`
          );
        }
        throw new EvalConfigError(`Admin API not reachable at ${url}: ${errorMessage(error)}`);
      }
    },
    async createSample(body) {
      requireToken();
      const response = await send<BottleEvalSampleResponse>("POST", "bottle-eval-admin/samples", body);
      const sampleId = response.sample?.sampleId;
      if (!sampleId) throw new CaptureApiError("POST bottle-eval-admin/samples returned no sampleId", 200);
      return String(sampleId);
    },
    async addFrame(sampleId, body) {
      requireToken();
      const response = await send<BottleEvalFrameAddResponse>(
        "POST",
        `bottle-eval-admin/samples/${encodeURIComponent(sampleId)}/frames`,
        body
      );
      if (!response.frameId) throw new CaptureApiError("POST …/frames returned no frameId", 200);
      return String(response.frameId);
    },
  };
}
