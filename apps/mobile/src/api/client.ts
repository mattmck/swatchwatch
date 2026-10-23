/**
 * Typed SwatchWatch API client for the mobile app, mirroring `apps/web/src/lib/api.ts`
 * (same routes, same `swatchwatch-shared` request/response types, same `ApiError`).
 * Only the endpoints the app uses are here; add more by copying the web function.
 */
import type {
  CaptureAnswerRequest,
  CaptureAnswerResponse,
  CaptureCheckResponse,
  CaptureFinalizeResponse,
  CaptureFrameRequest,
  CaptureFrameResponse,
  CaptureStartRequest,
  CaptureStartResponse,
  CaptureStatusResponse,
  CatalogSearchResponse,
  CatalogShadeDetail,
  ColorFamily,
  FinishTypeListResponse,
  ManicureCreateRequest,
  ManicureDeleteResponse,
  ManicureFilters,
  ManicureListResponse,
  ManicureMutationResponse,
  ManicurePhotoResponse,
  NailPhotoResponse,
  NailPhotoUploadRequest,
  Polish,
  PolishCreateRequest,
  PolishDupesResponse,
  PolishFilters,
  PolishImageMatchRequest,
  PolishImageMatchResponse,
  PolishListResponse,
  PolishUpdateRequest,
} from "swatchwatch-shared";
import { API_BASE_URL } from "@/config/env";
import { getAuthorizationHeader, notifySessionExpired } from "@/auth/auth-token";

export { API_BASE_URL };

export class ApiError extends Error {
  /**
   * @param status HTTP status (0 = the request never reached the API).
   * @param message Server `error`/`message` text, shown to users as-is.
   * @param body Parsed JSON error body when the server sent one.
   */
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Default timeout; capture frames get longer (uploads on cellular). */
const DEFAULT_TIMEOUT_MS = 20_000;
const UPLOAD_TIMEOUT_MS = 60_000;

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  /** Send the caller's credentials (default true). Catalog reads are anonymous. */
  auth?: boolean;
  /** Override the Authorization header (used to validate a token before storing it). */
  authorization?: string;
  timeoutMs?: number;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  let authorization: string | null = options.authorization ?? null;
  if (authorization === null && options.auth !== false) {
    try {
      authorization = await getAuthorizationHeader();
    } catch {
      throw new ApiError(0, "Couldn't renew your sign-in. Check your connection and try again.");
    }
  }
  if (authorization) headers.Authorization = authorization;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    throw new ApiError(
      0,
      aborted ? "The request timed out. Check your connection and try again." : `Can't reach SwatchWatch at ${API_BASE_URL}.`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 204) return undefined as T;
  if (response.status === 401 && options.auth !== false && options.authorization === undefined) {
    // The session's token was refused: send the user back to sign-in.
    notifySessionExpired();
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
    throw new ApiError(response.status, body?.error || body?.message || `Request failed (${response.status})`, body);
  }
  return (await response.json()) as T;
}

function query(params: Record<string, string | number | boolean | undefined | null>): string {
  const entries = Object.entries(params).filter(
    (entry): entry is [string, string | number | boolean] => entry[1] !== undefined && entry[1] !== null && entry[1] !== "",
  );
  if (entries.length === 0) return "";
  return `?${entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&")}`;
}

// ── Auth ────────────────────────────────────────────────────────────────────

/** `POST /api/auth/validate` response (see packages/functions/src/functions/auth.ts). */
export interface AuthValidateResponse {
  valid: boolean;
  userId?: number;
  email?: string;
  role?: string;
  error?: string;
  /** `account_suspended` (403) when an admin suspended the account. */
  code?: string;
}

/** Validate a bearer header with the API, exactly as the web does for its session. */
export async function validateAuth(authorization: string): Promise<AuthValidateResponse> {
  try {
    return await apiRequest<AuthValidateResponse>("/auth/validate", { method: "POST", authorization });
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      const body = (error.body ?? {}) as AuthValidateResponse;
      return { valid: false, error: body.error ?? error.message, code: body.code };
    }
    throw error;
  }
}

// ── Polishes ────────────────────────────────────────────────────────────────

export function listPolishes(filters: PolishFilters = {}): Promise<PolishListResponse> {
  return apiRequest<PolishListResponse>(
    `/polishes${query({
      search: filters.search,
      brand: filters.brand,
      finish: filters.finish,
      finishes: filters.finishes?.length ? filters.finishes.join(",") : undefined,
      scope: filters.scope && filters.scope !== "all" ? filters.scope : undefined,
      status: filters.status?.length ? filters.status.join(",") : undefined,
      untried: filters.untried ? "true" : undefined,
      family: filters.families?.length ? filters.families.join(",") : undefined,
      sortBy: filters.sortBy,
      sortOrder: filters.sortOrder,
      page: filters.page,
      pageSize: filters.pageSize,
    })}`,
  );
}

const LIST_ALL_PAGE_SIZE = 250;

/** Every row of a filter set, walking the paged API (web: `listAllPolishes`). */
export async function listAllPolishes(filters: Omit<PolishFilters, "page" | "pageSize"> = {}): Promise<Polish[]> {
  const first = await listPolishes({ ...filters, page: 1, pageSize: LIST_ALL_PAGE_SIZE });
  const totalPages = Math.ceil(first.total / LIST_ALL_PAGE_SIZE);
  const rest = await Promise.all(
    Array.from({ length: Math.max(0, totalPages - 1) }, (_, i) =>
      listPolishes({ ...filters, page: i + 2, pageSize: LIST_ALL_PAGE_SIZE }),
    ),
  );
  const byId = new Map([...first.polishes, ...rest.flatMap((page) => page.polishes)].map((p) => [p.id, p]));
  return [...byId.values()];
}

/** One polish by shade id (the caller's inventory fields when they have a row). */
export function getPolish(id: string | number): Promise<Polish> {
  return apiRequest<Polish>(`/polishes/${encodeURIComponent(String(id))}`);
}

/**
 * `POST /api/polishes`: the manual add form. Creates (or matches by brand + name) the shade and
 * the caller's inventory row; a `barcode` is remembered for the caller only (#21).
 */
export function createPolish(data: PolishCreateRequest): Promise<Polish> {
  return apiRequest<Polish>("/polishes", { method: "POST", body: data });
}

/** Public finish reference rows (`GET /api/reference/finishes`, no auth). */
export function listReferenceFinishTypes(): Promise<FinishTypeListResponse> {
  return apiRequest<FinishTypeListResponse>("/reference/finishes", { auth: false });
}

/**
 * `PUT /api/polishes/{shadeId}`: inventory quick actions. On a shade the caller has no row
 * for, this creates one (how Search's "Add" / "Wishlist" work, like the web).
 */
export function updatePolish(id: string | number, data: PolishUpdateRequest): Promise<Polish> {
  return apiRequest<Polish>(`/polishes/${encodeURIComponent(String(id))}`, { method: "PUT", body: data });
}

/** Remove the caller's inventory row (used to take a polish off the wishlist). */
export function deletePolish(id: string | number): Promise<{ message: string; id: number }> {
  return apiRequest(`/polishes/${encodeURIComponent(String(id))}`, { method: "DELETE" });
}

/** Owned near-dupes of a shade (#265). */
export function getPolishDupes(id: string | number, options?: { limit?: number }): Promise<PolishDupesResponse> {
  return apiRequest<PolishDupesResponse>(
    `/polishes/${encodeURIComponent(String(id))}/dupes${query({ limit: options?.limit })}`,
  );
}

/** Match owned polishes to a photo's dominant colors (#105). `image` is a base64 data URL. */
export function matchPolishesToImage(
  image: string,
  options?: Omit<PolishImageMatchRequest, "image">,
): Promise<PolishImageMatchResponse> {
  return apiRequest<PolishImageMatchResponse>("/polishes/match-image", {
    method: "POST",
    body: { image, ...options } satisfies PolishImageMatchRequest,
    timeoutMs: UPLOAD_TIMEOUT_MS,
  });
}

// ── Mani log ────────────────────────────────────────────────────────────────

/** The caller's manicures, newest first (`GET /api/manicures`). */
export function listManicures(filters: ManicureFilters = {}): Promise<ManicureListResponse> {
  return apiRequest<ManicureListResponse>(
    `/manicures${query({
      from: filters.from,
      to: filters.to,
      shadeId: filters.shadeId,
      page: filters.page,
      pageSize: filters.pageSize,
    })}`,
  );
}

export function createManicure(data: ManicureCreateRequest): Promise<ManicureMutationResponse> {
  return apiRequest<ManicureMutationResponse>("/manicures", { method: "POST", body: data });
}

export function deleteManicure(id: string | number): Promise<ManicureDeleteResponse> {
  return apiRequest<ManicureDeleteResponse>(`/manicures/${encodeURIComponent(String(id))}`, { method: "DELETE" });
}

// ── Catalog (anonymous) ─────────────────────────────────────────────────────

export function searchCatalog(
  q: string,
  options?: { limit?: number; families?: ColorFamily[] },
): Promise<CatalogSearchResponse> {
  return apiRequest<CatalogSearchResponse>(
    `/catalog/search${query({
      q,
      limit: options?.limit,
      family: options?.families?.length ? options.families.join(",") : undefined,
    })}`,
    { auth: false },
  );
}

export function getShade(id: string | number): Promise<CatalogShadeDetail> {
  return apiRequest<CatalogShadeDetail>(`/catalog/shade/${encodeURIComponent(String(id))}`, { auth: false });
}

// ── Capture (Rapid Add) ─────────────────────────────────────────────────────

export function startCapture(data: CaptureStartRequest = {}): Promise<CaptureStartResponse> {
  return apiRequest<CaptureStartResponse>("/capture/start", { method: "POST", body: data });
}

/** Upload one frame. `imageBlobUrl` is a base64 `data:image/jpeg` URL (≤ 5 MB). */
export function addCaptureFrame(captureId: string, data: CaptureFrameRequest): Promise<CaptureFrameResponse> {
  return apiRequest<CaptureFrameResponse>(`/capture/${encodeURIComponent(captureId)}/frame`, {
    method: "POST",
    body: data,
    timeoutMs: UPLOAD_TIMEOUT_MS,
  });
}

/**
 * Read-only resolver check: the match plus the caller's relationship to it
 * (owned / wishlisted / notOwned). Never touches inventory or the session.
 */
export function checkCapture(captureId: string): Promise<CaptureCheckResponse> {
  return apiRequest<CaptureCheckResponse>(`/capture/${encodeURIComponent(captureId)}/check`, {
    method: "POST",
    timeoutMs: UPLOAD_TIMEOUT_MS,
  });
}

/** Finalize: resolves and, when matched, adds the polish to the collection. */
export function finalizeCapture(captureId: string): Promise<CaptureFinalizeResponse> {
  return apiRequest<CaptureFinalizeResponse>(`/capture/${encodeURIComponent(captureId)}/finalize`, {
    method: "POST",
    timeoutMs: UPLOAD_TIMEOUT_MS,
  });
}

export function getCaptureStatus(captureId: string): Promise<CaptureStatusResponse> {
  return apiRequest<CaptureStatusResponse>(`/capture/${encodeURIComponent(captureId)}/status`);
}

export function answerCaptureQuestion(captureId: string, data: CaptureAnswerRequest): Promise<CaptureAnswerResponse> {
  return apiRequest<CaptureAnswerResponse>(`/capture/${encodeURIComponent(captureId)}/answer`, {
    method: "POST",
    body: data,
  });
}

/** Human-readable message for any thrown value. */
export function errorMessage(error: unknown, fallback = "Something went wrong."): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

// ── Private photos (#270 nail photo, #327 mani photo) ───────────────────────
// Responses carry owner-scoped `v3` image URLs; render them with `PrivateImage` (fetched with
// the bearer token, kept in memory only).

function nailPhotoPath(inventoryItemId: string | number): string {
  return `/inventory/${encodeURIComponent(String(inventoryItemId))}/nail-photo`;
}

/** `{ photo: null }` when the item has no photo; 404 (ApiError) when it isn't the caller's item. */
export function getNailPhoto(inventoryItemId: string | number): Promise<NailPhotoResponse> {
  return apiRequest<NailPhotoResponse>(nailPhotoPath(inventoryItemId));
}

/** Upload or replace the nail photo. `image` is a base64 JPEG data URL (`prepareJpeg`). */
export function uploadNailPhoto(inventoryItemId: string | number, image: string): Promise<NailPhotoResponse> {
  return apiRequest<NailPhotoResponse>(nailPhotoPath(inventoryItemId), {
    method: "PUT",
    body: { image } satisfies NailPhotoUploadRequest,
    timeoutMs: UPLOAD_TIMEOUT_MS,
  });
}

/** Delete the nail photo (idempotent; 204). */
export function deleteNailPhoto(inventoryItemId: string | number): Promise<void> {
  return apiRequest<void>(nailPhotoPath(inventoryItemId), { method: "DELETE" });
}

/** Attach a photo to a saved manicure (`PUT /api/manicures/{id}/photo`; the manicure must exist first). */
export function uploadManicurePhoto(manicureId: string | number, image: string): Promise<ManicurePhotoResponse> {
  return apiRequest<ManicurePhotoResponse>(`/manicures/${encodeURIComponent(String(manicureId))}/photo`, {
    method: "PUT",
    body: { image } satisfies NailPhotoUploadRequest,
    timeoutMs: UPLOAD_TIMEOUT_MS,
  });
}

// ── Color search (#384) ─────────────────────────────────────────────────────

/**
 * Color polishes only (`?category=color`, D23) for the Search tab's By color mode, optionally
 * in some color families (`?family=`) and inventory statuses. Catalog rows come back with the
 * caller's status, like `listPolishes`. `nearHex` ranks on the server by OKLAB distance to the
 * nearest of those colors (nearest first, `colorDistance` on each row).
 */
export function listColorPolishes(
  filters: Pick<PolishFilters, "families" | "status" | "nearHex" | "page" | "pageSize"> = {},
): Promise<PolishListResponse> {
  return apiRequest<PolishListResponse>(
    `/polishes${query({
      category: "color",
      family: filters.families?.length ? filters.families.join(",") : undefined,
      status: filters.status?.length ? filters.status.join(",") : undefined,
      nearHex: filters.nearHex?.length ? filters.nearHex.map((hex) => hex.replace(/^#/, "")).join(",") : undefined,
      page: filters.page,
      pageSize: filters.pageSize,
    })}`,
  );
}

/** Every owned color polish, optionally in some families (walks the pages, like `listAllPolishes`). */
export async function listOwnedColorPolishes(families: ColorFamily[] = []): Promise<Polish[]> {
  const pageSize = 250;
  const first = await listColorPolishes({ status: ["owned"], families, page: 1, pageSize });
  const pages = Math.ceil(first.total / pageSize);
  const rest = await Promise.all(
    Array.from({ length: Math.max(0, pages - 1) }, (_, i) =>
      listColorPolishes({ status: ["owned"], families, page: i + 2, pageSize }),
    ),
  );
  return [...first.polishes, ...rest.flatMap((page) => page.polishes)];
}
