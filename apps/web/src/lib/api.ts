import type {
  BulkIngestionRequest,
  BulkIngestionResponse,
  ConnectorProtocol,
  CaptureAnswerRequest,
  CaptureAnswerResponse,
  CaptureFinalizeResponse,
  CaptureFrameRequest,
  CaptureFrameResponse,
  CaptureFrameType,
  IngestionJobListResponse,
  IngestionJobRunRequest,
  IngestionJobRunResponse,
  CaptureStartRequest,
  CaptureStartResponse,
  CaptureStatusResponse,
  AdminJobsListResponse,
  AdminUserListResponse,
  AdminUserMergeRequest,
  AdminUserMergeResponse,
  ShadeReviewActionResponse,
  ShadeReviewApproveRequest,
  ShadeReviewCandidatesResponse,
  ShadeReviewListResponse,
  ShadeReviewMergeRequest,
  ShadeReviewMergeResponse,
  ShadeReviewQueueState,
  ShadeReviewRejectRequest,
  Polish,
  PolishCreateRequest,
  PolishUpdateRequest,
  PolishListResponse,
  PolishFilters,
  PolishImageMatchRequest,
  PolishImageMatchResponse,
  PolishImportCreateRequest,
  PolishImportDecision,
  PolishImportSession,
  PolishImportCommitResponse,
  PolishDupesBatchRequest,
  PolishDupesBatchResponse,
  PolishDupesResponse,
  CatalogSearchResponse,
  ColorFamily,
  CatalogShadeDetail,
  PolishFinish,
  FinishType,
  FinishNormalization,
  FinishNormalizationCreateRequest,
  FinishNormalizationListResponse,
  FinishNormalizationUpdateRequest,
  FinishTypeCreateRequest,
  FinishTypeUpdateRequest,
  FinishTypeUpdateResponse,
  FinishTypeListResponse,
  ReferenceHarmonyType,
  HarmonyTypeCreateRequest,
  HarmonyTypeUpdateRequest,
  HarmonyTypeListResponse,
  IngestionJob,
  Manicure,
  ManicureCreateRequest,
  ManicureDeleteResponse,
  ManicureFilters,
  ManicureListResponse,
  ManicureMutationResponse,
  ManicurePhotoResponse,
  ManicureUpdateRequest,
  PublicWishlistResponse,
  WishlistShareEnableRequest,
  WishlistShareStatus,
  CollectionExportFormat,
} from "swatchwatch-shared";
import { WISHLIST_SHARE_FEATURE_DISABLED_CODE } from "swatchwatch-shared";

import type { NailPhotoResponse } from "swatchwatch-shared";

import { getAccessToken } from "./auth-token";
import {
  fetchCollectionExport,
  type CollectionExportOptions,
  type DownloadedCollectionExport,
} from "./collection-export";

export const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:7071/api";
const MAX_CAPTURE_FRAME_BYTES = 5 * 1024 * 1024;
const LIST_ALL_POLISHES_PAGE_SIZE = 250;
const listPolishesInFlight = new Map<string, Promise<PolishListResponse>>();

export class ApiError extends Error {
  /**
   * @param status HTTP status code.
   * @param message Server-provided `error`/`message` text (shown to users as-is).
   * @param body Parsed JSON error body, when the server sent one (e.g. `FinishTypeInUseResponse`).
   */
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
    this.name = "ApiError";
  }
}

export async function getAuthHeaders(options?: { admin?: boolean }): Promise<Record<string, string>> {
  if (process.env.NEXT_PUBLIC_AUTH_DEV_BYPASS === "true") {
    const devUserId = options?.admin
      ? process.env.NEXT_PUBLIC_AUTH_DEV_ADMIN_USER_ID || "2"
      : "1";
    return { Authorization: `Bearer dev:${devUserId}` };
  }

  const token = getAccessToken();
  if (token) {
    return { Authorization: `Bearer ${token}` };
  }

  return {};
}

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Unknown error" }));
    throw new ApiError(response.status, error.error || error.message || "Request failed", error);
  }
  return response.json();
}

/**
 * Resolve the caller's internal user id via `POST /api/auth/validate`.
 * Returns null when there is no token or it doesn't validate. Used to tag
 * browser telemetry (never the email).
 */
export async function getCurrentUserId(): Promise<number | null> {
  const headers = await getAuthHeaders();
  if (!headers.Authorization) return null;

  const response = await fetch(`${API_BASE_URL}/auth/validate`, { method: "POST", headers });
  if (!response.ok) return null;
  const body = (await response.json().catch(() => null)) as { valid?: boolean; userId?: unknown } | null;
  return body?.valid && typeof body.userId === "number" ? body.userId : null;
}

export async function listPolishes(filters?: PolishFilters): Promise<PolishListResponse> {
  const params = new URLSearchParams();

  if (filters?.search) params.set("search", filters.search);
  if (filters?.brand) params.set("brand", filters.brand);
  if (filters?.finish) params.set("finish", filters.finish);
  if (filters?.finishes?.length) params.set("finishes", filters.finishes.join(","));
  if (filters?.scope && filters.scope !== "all") params.set("scope", filters.scope);
  if (filters?.availability && filters.availability !== "all") {
    params.set("availability", filters.availability);
  }
  if (filters?.status?.length) params.set("status", filters.status.join(","));
  if (filters?.untried) params.set("untried", "true");
  if (filters?.tone) params.set("tone", filters.tone);
  if (filters?.families?.length) params.set("family", filters.families.join(","));
  if (filters?.tags?.length) params.set("tags", filters.tags.join(","));
  if (filters?.sortBy) params.set("sortBy", filters.sortBy);
  if (filters?.sortOrder) params.set("sortOrder", filters.sortOrder);
  if (filters?.page) params.set("page", String(filters.page));
  if (filters?.pageSize) params.set("pageSize", String(filters.pageSize));

  const qs = params.toString();
  const url = `${API_BASE_URL}/polishes${qs ? `?${qs}` : ""}`;
  const cacheKey = url;
  if (!listPolishesInFlight.has(cacheKey)) {
    listPolishesInFlight.set(
      cacheKey,
      (async () => {
        const response = await fetch(url, { headers: await getAuthHeaders() });
        return handleResponse<PolishListResponse>(response);
      })().finally(() => {
        listPolishesInFlight.delete(cacheKey);
      })
    );
  }
  return listPolishesInFlight.get(cacheKey) as Promise<PolishListResponse>;
}

/**
 * Fetch all polish rows for the current user by walking paginated API results.
 * The API currently returns paginated responses (default pageSize=50).
 */
export async function listAllPolishes(
  filters?: Omit<PolishFilters, "page" | "pageSize"> & { pageSize?: number }
): Promise<Polish[]> {
  const dedupeKey = JSON.stringify({
    ...(filters ?? {}),
    pageSize: filters?.pageSize ?? LIST_ALL_POLISHES_PAGE_SIZE,
  });

  if (!listAllPolishesInFlight.has(dedupeKey)) {
    listAllPolishesInFlight.set(
      dedupeKey,
      (async () => {
        const pageSize = Math.min(
          LIST_ALL_POLISHES_PAGE_SIZE,
          Math.max(1, filters?.pageSize ?? LIST_ALL_POLISHES_PAGE_SIZE)
        );
        const firstPage = await listPolishes({
          ...filters,
          page: 1,
          pageSize,
        });

        const totalPages = Math.ceil(firstPage.total / pageSize);
        const remainingPageRequests =
          totalPages > 1
            ? Array.from({ length: totalPages - 1 }, (_, idx) =>
                listPolishes({
                  ...filters,
                  page: idx + 2,
                  pageSize,
                })
              )
            : [];
        const remainingPages = await Promise.all(remainingPageRequests);
        const allPolishes = [
          ...firstPage.polishes,
          ...remainingPages.flatMap((page) => page.polishes),
        ];

        // Defensive de-dupe by inventory item id in case of overlapping pages.
        return Array.from(
          new Map(allPolishes.map((polish) => [polish.id, polish])).values()
        );
      })().finally(() => {
        listAllPolishesInFlight.delete(dedupeKey);
      })
    );
  }

  return listAllPolishesInFlight.get(dedupeKey) as Promise<Polish[]>;
}

const listAllPolishesInFlight = new Map<string, Promise<Polish[]>>();

export async function getPolish(id: string | number): Promise<Polish> {
  const response = await fetch(`${API_BASE_URL}/polishes/${id}`, {
    headers: await getAuthHeaders(),
  });
  return handleResponse<Polish>(response);
}

export async function createPolish(data: PolishCreateRequest): Promise<Polish> {
  const response = await fetch(`${API_BASE_URL}/polishes`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...await getAuthHeaders() },
    body: JSON.stringify(data),
  });
  return handleResponse<Polish>(response);
}

export async function updatePolish(id: string | number, data: PolishUpdateRequest): Promise<Polish> {
  const response = await fetch(`${API_BASE_URL}/polishes/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...await getAuthHeaders() },
    body: JSON.stringify(data),
  });
  return handleResponse<Polish>(response);
}

export async function deletePolish(id: string | number): Promise<{ message: string; id: number }> {
  const response = await fetch(`${API_BASE_URL}/polishes/${id}`, {
    method: "DELETE",
    headers: await getAuthHeaders(),
  });
  return handleResponse<{ message: string; id: number }>(response);
}

/** List the caller's manicures (`GET /api/manicures`), newest first. */
export async function listManicures(filters?: ManicureFilters): Promise<ManicureListResponse> {
  const params = new URLSearchParams();
  if (filters?.from) params.set("from", filters.from);
  if (filters?.to) params.set("to", filters.to);
  if (filters?.shadeId !== undefined) params.set("shadeId", String(filters.shadeId));
  if (filters?.page) params.set("page", String(filters.page));
  if (filters?.pageSize) params.set("pageSize", String(filters.pageSize));
  const qs = params.toString();
  const response = await fetch(`${API_BASE_URL}/manicures${qs ? `?${qs}` : ""}`, {
    headers: await getAuthHeaders(),
  });
  return handleResponse<ManicureListResponse>(response);
}

export async function getManicure(id: string | number): Promise<Manicure> {
  const response = await fetch(`${API_BASE_URL}/manicures/${id}`, { headers: await getAuthHeaders() });
  return handleResponse<Manicure>(response);
}

/** Log a manicure; the response carries the recomputed wear stats of its polishes. */
export async function createManicure(data: ManicureCreateRequest): Promise<ManicureMutationResponse> {
  const response = await fetch(`${API_BASE_URL}/manicures`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...await getAuthHeaders() },
    body: JSON.stringify(data),
  });
  return handleResponse<ManicureMutationResponse>(response);
}

export async function updateManicure(
  id: string | number,
  data: ManicureUpdateRequest
): Promise<ManicureMutationResponse> {
  const response = await fetch(`${API_BASE_URL}/manicures/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...await getAuthHeaders() },
    body: JSON.stringify(data),
  });
  return handleResponse<ManicureMutationResponse>(response);
}

export async function deleteManicure(id: string | number): Promise<ManicureDeleteResponse> {
  const response = await fetch(`${API_BASE_URL}/manicures/${id}`, {
    method: "DELETE",
    headers: await getAuthHeaders(),
  });
  return handleResponse<ManicureDeleteResponse>(response);
}

function manicurePhotoUrl(manicureId: string | number): string {
  return `${API_BASE_URL}/manicures/${encodeURIComponent(String(manicureId))}/photo`;
}

/**
 * Upload or replace a manicure's photo (#327). `image` is a base64 data URL (see
 * `prepareNailPhotoUpload`); the server re-encodes it and strips all metadata before storing it.
 */
export async function uploadManicurePhoto(manicureId: string | number, image: string): Promise<ManicurePhotoResponse> {
  const response = await fetch(manicurePhotoUrl(manicureId), {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...await getAuthHeaders() },
    body: JSON.stringify({ image }),
  });
  return handleResponse<ManicurePhotoResponse>(response);
}

/** Remove a manicure's photo (idempotent; 204). A photo uploaded for this mani is deleted. */
export async function deleteManicurePhoto(manicureId: string | number): Promise<void> {
  const response = await fetch(manicurePhotoUrl(manicureId), {
    method: "DELETE",
    headers: await getAuthHeaders(),
  });
  if (!response.ok) {
    await handleResponse<unknown>(response);
  }
}

/**
 * Download the caller's collection (`GET /api/polishes/export`) as CSV or JSON through the
 * authenticated API. Save the result with `saveBlobAsFile` from `@/lib/collection-export`.
 */
export async function exportCollection(
  format: CollectionExportFormat,
  options?: CollectionExportOptions
): Promise<DownloadedCollectionExport> {
  return fetchCollectionExport(
    format,
    { fetch: (input, init) => fetch(input, init), apiBaseUrl: API_BASE_URL, getAuthHeaders: () => getAuthHeaders() },
    options
  );
}

/**
 * Response payload for `POST /api/polishes/{id}/recalc-hex`.
 * All fields are optional because error/edge-case responses can omit values.
 * Consumers should handle both `undefined` (field absent) and `null` (explicitly unknown/not detected).
 */
export interface RecalcPolishHexResponse {
  /** Human-readable status text from the API; present on most success responses. */
  message?: string;
  /** Shade id as a string when the API resolves a target shade. */
  shadeId?: string;
  /** Canonical shade name when the API resolves a target shade. */
  shadeName?: string;
  /** Previously stored detected hex (`#RRGGBB`) or `null` if no prior detected value existed. */
  previousHex?: string | null;
  /** Newly detected hex (`#RRGGBB`) or `null` when image analysis cannot produce one. */
  detectedHex?: string | null;
  /** Detection confidence in the inclusive range 0..1, or `null` when not provided/applicable. */
  confidence?: number | null;
  /** Suggested canonical polish finishes, or `null` when no finishes are available. */
  finishes?: PolishFinish[] | null;
}

export async function recalcPolishHex(id: string | number): Promise<RecalcPolishHexResponse> {
  const response = await fetch(`${API_BASE_URL}/polishes/${id}/recalc-hex`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...await getAuthHeaders({ admin: true }) },
  });
  return handleResponse<RecalcPolishHexResponse>(response);
}

/**
 * Match the caller's owned polishes against the dominant colors of a photo.
 * `imageDataUrl` must be a base64 `data:image/...` URL; downscale it first
 * (see `downscaleImageFile`) to keep the payload small. The server never
 * stores the image.
 */
export async function matchPolishesToImage(
  imageDataUrl: string,
  options?: Omit<PolishImageMatchRequest, "image">
): Promise<PolishImageMatchResponse> {
  const body: PolishImageMatchRequest = { image: imageDataUrl, ...options };
  const response = await fetch(`${API_BASE_URL}/polishes/match-image`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...await getAuthHeaders() },
    body: JSON.stringify(body),
  });
  return handleResponse<PolishImageMatchResponse>(response);
}

/**
 * Dupe finder (#265): the caller's owned shades that are likely dupes of shade `id`, graded
 * HIGH/MEDIUM with the match-image thresholds and the finish rule (see `color/dupes.ts` in
 * swatchwatch-shared). `limit` caps `dupes` (1–20, default 5); `dupeCount` is never capped.
 */
export async function getPolishDupes(
  id: string | number,
  options?: { limit?: number }
): Promise<PolishDupesResponse> {
  const params = new URLSearchParams();
  if (options?.limit) params.set("limit", String(options.limit));
  const qs = params.toString();
  const response = await fetch(`${API_BASE_URL}/polishes/${id}/dupes${qs ? `?${qs}` : ""}`, {
    headers: await getAuthHeaders(),
  });
  return handleResponse<PolishDupesResponse>(response);
}

/**
 * Best owned dupe per shade for list hints, one request for up to
 * `DUPE_LIMITS.batchMaxShadeIds` ids. Prefer `fetchDupeHints` (lib/dupes.ts), which chunks
 * longer lists.
 */
export async function getPolishDupeHints(
  shadeIds: PolishDupesBatchRequest["shadeIds"]
): Promise<PolishDupesBatchResponse> {
  const body: PolishDupesBatchRequest = { shadeIds };
  const response = await fetch(`${API_BASE_URL}/polishes/dupes`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...await getAuthHeaders() },
    body: JSON.stringify(body),
  });
  return handleResponse<PolishDupesBatchResponse>(response);
}

/** Upload a CSV for import (`POST /api/polish-imports`): parses, fuzzy-matches, and opens a review session. */
export async function createPolishImport(data: PolishImportCreateRequest): Promise<PolishImportSession> {
  const response = await fetch(`${API_BASE_URL}/polish-imports`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...await getAuthHeaders() },
    body: JSON.stringify(data),
  });
  return handleResponse<PolishImportSession>(response);
}

export async function getPolishImport(id: string): Promise<PolishImportSession> {
  const response = await fetch(`${API_BASE_URL}/polish-imports/${encodeURIComponent(id)}`, {
    headers: await getAuthHeaders(),
  });
  return handleResponse<PolishImportSession>(response);
}

/** Save review decisions without committing (`PATCH /api/polish-imports/{id}`). */
export async function savePolishImportDecisions(
  id: string,
  decisions: PolishImportDecision[]
): Promise<PolishImportSession> {
  const response = await fetch(`${API_BASE_URL}/polish-imports/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...await getAuthHeaders() },
    body: JSON.stringify({ decisions }),
  });
  return handleResponse<PolishImportSession>(response);
}

/** Apply decisions and upsert the inventory rows (`POST /api/polish-imports/{id}/commit`). */
export async function commitPolishImport(
  id: string,
  decisions: PolishImportDecision[]
): Promise<PolishImportCommitResponse> {
  const response = await fetch(`${API_BASE_URL}/polish-imports/${encodeURIComponent(id)}/commit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...await getAuthHeaders() },
    body: JSON.stringify({ decisions }),
  });
  return handleResponse<PolishImportCommitResponse>(response);
}

export async function deletePolishImport(id: string): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/polish-imports/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: await getAuthHeaders(),
  });
  await handleResponse<unknown>(response);
}

export async function searchCatalog(
  q: string,
  limit?: number,
  options?: { families?: ColorFamily[] }
): Promise<CatalogSearchResponse> {
  const params = new URLSearchParams({ q });
  if (limit) params.set("limit", String(limit));
  if (options?.families?.length) params.set("family", options.families.join(","));

  const response = await fetch(`${API_BASE_URL}/catalog/search?${params}`);
  return handleResponse<CatalogSearchResponse>(response);
}

export async function getShade(id: string | number): Promise<CatalogShadeDetail> {
  const response = await fetch(`${API_BASE_URL}/catalog/shade/${id}`);
  return handleResponse<CatalogShadeDetail>(response);
}

export async function listIngestionJobs(params?: {
  limit?: number;
  source?: string;
}): Promise<IngestionJobListResponse> {
  const searchParams = new URLSearchParams();

  if (params?.limit) searchParams.set("limit", String(params.limit));
  if (params?.source) searchParams.set("source", params.source);

  const qs = searchParams.toString();
  const response = await fetch(`${API_BASE_URL}/ingestion/jobs${qs ? `?${qs}` : ""}`, {
    headers: await getAuthHeaders({ admin: true }),
  });

  return handleResponse<IngestionJobListResponse>(response);
}

export async function runIngestionJob(
  data: IngestionJobRunRequest
): Promise<IngestionJobRunResponse> {
  const response = await fetch(`${API_BASE_URL}/ingestion/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...await getAuthHeaders({ admin: true }) },
    body: JSON.stringify(data),
  });
  return handleResponse<IngestionJobRunResponse>(response);
}

/**
 * Call the admin-only POST /ingestion/bulk endpoint.
 *
 * Accepts a BulkIngestionRequest and returns a Promise that resolves to a
 * BulkIngestionResponse containing the queued jobs. Adds admin auth headers
 * with getAuthHeaders() and parses the response with handleResponse().
 */
export async function runBulkIngestion(
  data: BulkIngestionRequest
): Promise<BulkIngestionResponse> {
  const response = await fetch(`${API_BASE_URL}/ingestion/bulk`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...await getAuthHeaders({ admin: true }) },
    body: JSON.stringify(data),
  });
  return handleResponse<BulkIngestionResponse>(response);
}

export async function getIngestionJob(id: string | number): Promise<IngestionJobRunResponse> {
  const response = await fetch(`${API_BASE_URL}/ingestion/jobs/${id}`, {
    headers: await getAuthHeaders({ admin: true }),
  });
  return handleResponse<IngestionJobRunResponse>(response);
}

export async function cancelIngestionJob(
  id: string | number,
  reason?: string
): Promise<IngestionJobRunResponse> {
  const response = await fetch(`${API_BASE_URL}/ingestion/jobs/${id}/cancel`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", ...await getAuthHeaders({ admin: true }) },
    body: JSON.stringify({ reason: reason || "Cancelled by admin" }),
  });
  return handleResponse<IngestionJobRunResponse>(response);
}

export interface DataSource {
  dataSourceId: number;
  name: string;
  baseUrl: string | null;
  protocol?: ConnectorProtocol;
  queueable?: boolean;
}

export interface ListDataSourcesResponse {
  sources: DataSource[];
}

export async function listDataSources(): Promise<ListDataSourcesResponse> {
  const response = await fetch(`${API_BASE_URL}/ingestion/sources`, {
    headers: await getAuthHeaders({ admin: true }),
  });
  return handleResponse<ListDataSourcesResponse>(response);
}

export interface IngestionSettings {
  downloadImages: boolean;
  detectHex: boolean;
}

export interface GlobalSettingsResponse {
  settings: IngestionSettings;
}

export async function getGlobalSettings(): Promise<GlobalSettingsResponse> {
  const response = await fetch(`${API_BASE_URL}/ingestion/settings`, {
    headers: await getAuthHeaders({ admin: true }),
  });
  return handleResponse<GlobalSettingsResponse>(response);
}

export async function updateGlobalSettings(settings: Partial<IngestionSettings>): Promise<GlobalSettingsResponse> {
  const response = await fetch(`${API_BASE_URL}/ingestion/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...await getAuthHeaders({ admin: true }) },
    body: JSON.stringify(settings),
  });
  return handleResponse<GlobalSettingsResponse>(response);
}

export async function updateDataSourceSettings(
  dataSourceId: number,
  settings: Partial<IngestionSettings>
): Promise<{ success: boolean }> {
  const response = await fetch(`${API_BASE_URL}/ingestion/sources/${dataSourceId}/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...await getAuthHeaders({ admin: true }) },
    body: JSON.stringify(settings),
  });
  return handleResponse<{ success: boolean }>(response);
}

export async function startCapture(data?: CaptureStartRequest): Promise<CaptureStartResponse> {

  const response = await fetch(`${API_BASE_URL}/capture/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...await getAuthHeaders() },
    body: JSON.stringify(data || {}),
  });
  return handleResponse<CaptureStartResponse>(response);
}

export async function addCaptureFrame(
  captureId: string,
  data: CaptureFrameRequest
): Promise<CaptureFrameResponse> {
  const response = await fetch(`${API_BASE_URL}/capture/${captureId}/frame`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...await getAuthHeaders() },
    body: JSON.stringify(data),
  });
  return handleResponse<CaptureFrameResponse>(response);
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Failed to read image file"));
    };
    reader.onerror = () => reject(new Error("Failed to read image file"));
    reader.readAsDataURL(file);
  });
}

export async function addCaptureFrameFromFile(
  captureId: string,
  params: {
    frameType: CaptureFrameType;
    file: File;
    quality?: Record<string, unknown>;
  }
): Promise<CaptureFrameResponse> {
  const { frameType, file, quality } = params;

  if (!file.type.startsWith("image/")) {
    throw new ApiError(400, "Only image files are supported for capture frames");
  }
  if (file.size > MAX_CAPTURE_FRAME_BYTES) {
    throw new ApiError(400, `Image must be ${MAX_CAPTURE_FRAME_BYTES / (1024 * 1024)}MB or smaller`);
  }

  const imageBlobUrl = await fileToDataUrl(file);
  return addCaptureFrame(captureId, {
    frameType,
    imageBlobUrl,
    quality,
  });
}

export async function finalizeCapture(captureId: string): Promise<CaptureFinalizeResponse> {
  const response = await fetch(`${API_BASE_URL}/capture/${captureId}/finalize`, {
    method: "POST",
    headers: await getAuthHeaders(),
  });
  return handleResponse<CaptureFinalizeResponse>(response);
}

export async function getCaptureStatus(captureId: string): Promise<CaptureStatusResponse> {
  const response = await fetch(`${API_BASE_URL}/capture/${captureId}/status`, {
    headers: await getAuthHeaders(),
  });
  return handleResponse<CaptureStatusResponse>(response);
}

export async function answerCaptureQuestion(
  captureId: string,
  data: CaptureAnswerRequest
): Promise<CaptureAnswerResponse> {
  const response = await fetch(`${API_BASE_URL}/capture/${captureId}/answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...await getAuthHeaders() },
    body: JSON.stringify(data),
  });
  return handleResponse<CaptureAnswerResponse>(response);
}

export interface QueueStatsResponse {
  queueName: string;
  messageCount: number;
  timestamp: string;
}

export interface QueuePurgeResponse {
  success: boolean;
  queueName: string;
  timestamp: string;
  error?: string;
}

export async function getQueueStats(): Promise<QueueStatsResponse> {
  const response = await fetch(`${API_BASE_URL}/ingestion/queue/stats`, {
    headers: await getAuthHeaders({ admin: true }),
  });
  return handleResponse<QueueStatsResponse>(response);
}

export async function purgeQueue(): Promise<QueuePurgeResponse> {
  const response = await fetch(`${API_BASE_URL}/ingestion/queue/messages`, {
    method: "DELETE",
    headers: await getAuthHeaders({ admin: true }),
  });
  return handleResponse<QueuePurgeResponse>(response);
}

/** List admin ingestion jobs from `/api/reference-admin/jobs` (admin auth required). */
export async function listAdminJobs(params?: {
  page?: number;
  pageSize?: number;
  status?: IngestionJob["status"];
}): Promise<AdminJobsListResponse> {
  const searchParams = new URLSearchParams();
  if (typeof params?.page === "number") searchParams.set("page", String(params.page));
  if (typeof params?.pageSize === "number") searchParams.set("pageSize", String(params.pageSize));
  if (params?.status) searchParams.set("status", params.status);

  const qs = searchParams.toString();
  const response = await fetch(`${API_BASE_URL}/reference-admin/jobs${qs ? `?${qs}` : ""}`, {
    headers: await getAuthHeaders({ admin: true }),
  });

  return handleResponse<AdminJobsListResponse>(response);
}

/** List finish reference rows from `/api/reference-admin/finishes` (admin auth required). */
export async function listFinishTypes(): Promise<FinishTypeListResponse> {
  const response = await fetch(`${API_BASE_URL}/reference-admin/finishes`, {
    headers: await getAuthHeaders({ admin: true }),
  });
  return handleResponse<FinishTypeListResponse>(response);
}

/** List public finish reference rows from `/api/reference/finishes` (no auth). */
export async function listReferenceFinishTypes(): Promise<FinishTypeListResponse> {
  const response = await fetch(`${API_BASE_URL}/reference/finishes`);
  return handleResponse<FinishTypeListResponse>(response);
}

/** Create a finish reference row via `POST /api/reference-admin/finishes` (admin auth required). */
export async function createFinishType(data: FinishTypeCreateRequest): Promise<FinishType> {
  const response = await fetch(`${API_BASE_URL}/reference-admin/finishes`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...await getAuthHeaders({ admin: true }) },
    body: JSON.stringify(data),
  });
  return handleResponse<FinishType>(response);
}

/**
 * Update a finish reference row via `PUT /api/reference-admin/finishes/{id}` (admin auth required).
 * A `name` change renames the finish everywhere (shades, finish normalizations) and the response's
 * `rename` holds the counts. A name another finish type already has is refused with 409: the thrown
 * `ApiError` carries the server's message and the `FinishTypeNameTakenResponse` body.
 */
export async function updateFinishType(
  finishTypeId: number,
  data: FinishTypeUpdateRequest
): Promise<FinishTypeUpdateResponse> {
  const response = await fetch(`${API_BASE_URL}/reference-admin/finishes/${finishTypeId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...await getAuthHeaders({ admin: true }) },
    body: JSON.stringify(data),
  });
  return handleResponse<FinishTypeUpdateResponse>(response);
}

/**
 * Delete a finish reference row via `DELETE /api/reference-admin/finishes/{id}` (admin auth required).
 * A finish type still used by shades or finish normalizations is refused with 409: the thrown
 * `ApiError` carries the server's message (with the usage counts) and the `FinishTypeInUseResponse` body.
 */
export async function deleteFinishType(
  finishTypeId: number
): Promise<{ success?: boolean; message?: string }> {
  const response = await fetch(`${API_BASE_URL}/reference-admin/finishes/${finishTypeId}`, {
    method: "DELETE",
    headers: await getAuthHeaders({ admin: true }),
  });
  return handleResponse<{ success?: boolean; message?: string }>(response);
}

/** List harmony reference rows from `/api/reference-admin/harmonies` (admin auth required). */
export async function listHarmonyTypes(): Promise<HarmonyTypeListResponse> {
  const response = await fetch(`${API_BASE_URL}/reference-admin/harmonies`, {
    headers: await getAuthHeaders({ admin: true }),
  });
  return handleResponse<HarmonyTypeListResponse>(response);
}

/** List public harmony reference rows from `/api/reference/harmonies` (no auth). */
export async function listReferenceHarmonyTypes(): Promise<HarmonyTypeListResponse> {
  const response = await fetch(`${API_BASE_URL}/reference/harmonies`);
  return handleResponse<HarmonyTypeListResponse>(response);
}

/** Create a harmony reference row via `POST /api/reference-admin/harmonies` (admin auth required). */
export async function createHarmonyType(data: HarmonyTypeCreateRequest): Promise<ReferenceHarmonyType> {
  const response = await fetch(`${API_BASE_URL}/reference-admin/harmonies`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...await getAuthHeaders({ admin: true }) },
    body: JSON.stringify(data),
  });
  return handleResponse<ReferenceHarmonyType>(response);
}

/** Update a harmony reference row via `PUT /api/reference-admin/harmonies/{id}` (admin auth required). */
export async function updateHarmonyType(
  harmonyTypeId: number,
  data: HarmonyTypeUpdateRequest
): Promise<ReferenceHarmonyType> {
  const response = await fetch(`${API_BASE_URL}/reference-admin/harmonies/${harmonyTypeId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...await getAuthHeaders({ admin: true }) },
    body: JSON.stringify(data),
  });
  return handleResponse<ReferenceHarmonyType>(response);
}

/** Delete a harmony reference row via `DELETE /api/reference-admin/harmonies/{id}` (admin auth required). */
export async function deleteHarmonyType(
  harmonyTypeId: number
): Promise<{ success?: boolean; message?: string }> {
  const response = await fetch(`${API_BASE_URL}/reference-admin/harmonies/${harmonyTypeId}`, {
    method: "DELETE",
    headers: await getAuthHeaders({ admin: true }),
  });
  return handleResponse<{ success?: boolean; message?: string }>(response);
}

/** List finish normalization rows from `/api/reference-admin/finish-normalizations` (admin auth required). */
export async function listFinishNormalizations(): Promise<FinishNormalizationListResponse> {
  const response = await fetch(`${API_BASE_URL}/reference-admin/finish-normalizations`, {
    headers: await getAuthHeaders({ admin: true }),
  });
  return handleResponse<FinishNormalizationListResponse>(response);
}

/** Create a finish normalization row via `POST /api/reference-admin/finish-normalizations` (admin auth required). */
export async function createFinishNormalization(
  data: FinishNormalizationCreateRequest
): Promise<FinishNormalization> {
  const response = await fetch(`${API_BASE_URL}/reference-admin/finish-normalizations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...await getAuthHeaders({ admin: true }) },
    body: JSON.stringify(data),
  });
  return handleResponse<FinishNormalization>(response);
}

/** Update a finish normalization row via `PUT /api/reference-admin/finish-normalizations/{id}` (admin auth required). */
export async function updateFinishNormalization(
  finishNormalizationId: number,
  data: FinishNormalizationUpdateRequest
): Promise<FinishNormalization> {
  const response = await fetch(
    `${API_BASE_URL}/reference-admin/finish-normalizations/${finishNormalizationId}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...await getAuthHeaders({ admin: true }) },
      body: JSON.stringify(data),
    }
  );
  return handleResponse<FinishNormalization>(response);
}

/** Delete a finish normalization row via `DELETE /api/reference-admin/finish-normalizations/{id}` (admin auth required). */
export async function deleteFinishNormalization(
  finishNormalizationId: number
): Promise<{ success?: boolean; message?: string }> {
  const response = await fetch(
    `${API_BASE_URL}/reference-admin/finish-normalizations/${finishNormalizationId}`,
    {
      method: "DELETE",
      headers: await getAuthHeaders({ admin: true }),
    }
  );
  return handleResponse<{ success?: boolean; message?: string }>(response);
}

/** List users for admin account-repair workflows (`GET /api/users-admin`). */
export async function listAdminUsers(params?: {
  limit?: number;
}): Promise<AdminUserListResponse> {
  const searchParams = new URLSearchParams();
  if (typeof params?.limit === "number") searchParams.set("limit", String(params.limit));
  const qs = searchParams.toString();
  const response = await fetch(`${API_BASE_URL}/users-admin${qs ? `?${qs}` : ""}`, {
    headers: await getAuthHeaders({ admin: true }),
  });
  return handleResponse<AdminUserListResponse>(response);
}

/** Merge one duplicate user into another (`POST /api/users-admin/merge`). */
export async function mergeAdminUsers(
  data: AdminUserMergeRequest
): Promise<AdminUserMergeResponse> {
  const response = await fetch(`${API_BASE_URL}/users-admin/merge`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...await getAuthHeaders({ admin: true }) },
    body: JSON.stringify(data),
  });
  return handleResponse<AdminUserMergeResponse>(response);
}

// ── Private nail photos (#270) ──────────────────────────────────────────────

function nailPhotoUrl(inventoryItemId: string | number): string {
  return `${API_BASE_URL}/inventory/${encodeURIComponent(String(inventoryItemId))}/nail-photo`;
}

/** The caller's private on-nail photo for one of their inventory items (`{ photo: null }` when none). */
export async function getNailPhoto(inventoryItemId: string | number): Promise<NailPhotoResponse> {
  const response = await fetch(nailPhotoUrl(inventoryItemId), {
    headers: await getAuthHeaders(),
    cache: "no-store",
  });
  return handleResponse<NailPhotoResponse>(response);
}

/**
 * Upload or replace the nail photo. `image` is a base64 data URL (see `prepareNailPhotoUpload`);
 * the server re-encodes it and strips all metadata (EXIF/GPS) before storing it privately.
 */
export async function uploadNailPhoto(
  inventoryItemId: string | number,
  image: string
): Promise<NailPhotoResponse> {
  const response = await fetch(nailPhotoUrl(inventoryItemId), {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...await getAuthHeaders() },
    body: JSON.stringify({ image }),
  });
  return handleResponse<NailPhotoResponse>(response);
}

/** Delete the nail photo (idempotent; 204). */
export async function deleteNailPhoto(inventoryItemId: string | number): Promise<void> {
  const response = await fetch(nailPhotoUrl(inventoryItemId), {
    method: "DELETE",
    headers: await getAuthHeaders(),
  });
  if (!response.ok) {
    await handleResponse<unknown>(response);
  }
}

/** List the admin review queue of `user_submitted` shades (`GET /api/shades-admin/review`). */
export async function listShadeReviewQueue(params?: {
  state?: ShadeReviewQueueState;
  page?: number;
  pageSize?: number;
  q?: string;
  candidates?: number;
}): Promise<ShadeReviewListResponse> {
  const searchParams = new URLSearchParams();
  if (params?.state) searchParams.set("state", params.state);
  if (typeof params?.page === "number") searchParams.set("page", String(params.page));
  if (typeof params?.pageSize === "number") searchParams.set("pageSize", String(params.pageSize));
  if (params?.q?.trim()) searchParams.set("q", params.q.trim());
  if (typeof params?.candidates === "number") searchParams.set("candidates", String(params.candidates));
  const qs = searchParams.toString();
  const response = await fetch(`${API_BASE_URL}/shades-admin/review${qs ? `?${qs}` : ""}`, {
    headers: await getAuthHeaders({ admin: true }),
  });
  return handleResponse<ShadeReviewListResponse>(response);
}

/** Merge candidates for one submission, optionally searched by name (`GET .../{id}/candidates`). */
export async function getShadeReviewCandidates(
  shadeId: string | number,
  params?: { q?: string; limit?: number }
): Promise<ShadeReviewCandidatesResponse> {
  const searchParams = new URLSearchParams();
  if (params?.q?.trim()) searchParams.set("q", params.q.trim());
  if (typeof params?.limit === "number") searchParams.set("limit", String(params.limit));
  const qs = searchParams.toString();
  const response = await fetch(
    `${API_BASE_URL}/shades-admin/review/${encodeURIComponent(String(shadeId))}/candidates${qs ? `?${qs}` : ""}`,
    { headers: await getAuthHeaders({ admin: true }) }
  );
  return handleResponse<ShadeReviewCandidatesResponse>(response);
}

async function postShadeReviewAction<T>(shadeId: string | number, action: string, body: unknown): Promise<T> {
  const response = await fetch(
    `${API_BASE_URL}/shades-admin/review/${encodeURIComponent(String(shadeId))}/${action}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...await getAuthHeaders({ admin: true }) },
      body: JSON.stringify(body ?? {}),
    }
  );
  return handleResponse<T>(response);
}

/** Approve a submission (optionally with edits): it becomes an `active` catalog shade. */
export async function approveShadeReview(
  shadeId: string | number,
  data: ShadeReviewApproveRequest = {}
): Promise<ShadeReviewActionResponse> {
  return postShadeReviewAction<ShadeReviewActionResponse>(shadeId, "approve", data);
}

/** Merge a submission into an active shade, reassigning every inventory row. */
export async function mergeShadeReview(
  shadeId: string | number,
  data: ShadeReviewMergeRequest
): Promise<ShadeReviewMergeResponse> {
  return postShadeReviewAction<ShadeReviewMergeResponse>(shadeId, "merge", data);
}

/** Reject a submission: it stays private to its submitter. */
export async function rejectShadeReview(
  shadeId: string | number,
  data: ShadeReviewRejectRequest = {}
): Promise<ShadeReviewActionResponse> {
  return postShadeReviewAction<ShadeReviewActionResponse>(shadeId, "reject", data);
}

// ── Shareable wishlist (#268) ───────────────────────────────────────────────
// Behind the server-side SHAREABLE_WISHLIST_ENABLED flag: while it is off every route answers
// 404 `{ code: "feature_disabled" }`, which the client treats as "feature unavailable".

async function isFeatureDisabled(response: Response): Promise<boolean> {
  if (response.status !== 404) return false;
  const body = (await response.clone().json().catch(() => null)) as { code?: unknown } | null;
  return body?.code === WISHLIST_SHARE_FEATURE_DISABLED_CODE;
}

/** The caller's share-link status, or null when the feature is disabled on the server. */
export async function getWishlistShare(): Promise<WishlistShareStatus | null> {
  const response = await fetch(`${API_BASE_URL}/wishlist-share`, {
    headers: await getAuthHeaders(),
    cache: "no-store",
  });
  if (await isFeatureDisabled(response)) return null;
  return handleResponse<WishlistShareStatus>(response);
}

/** Enable the share link (idempotent) and/or set its public display name. */
export async function enableWishlistShare(data: WishlistShareEnableRequest = {}): Promise<WishlistShareStatus> {
  const response = await fetch(`${API_BASE_URL}/wishlist-share`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...await getAuthHeaders() },
    body: JSON.stringify(data),
  });
  return handleResponse<WishlistShareStatus>(response);
}

/** Replace the share token; the previous link stops working immediately. */
export async function rotateWishlistShare(): Promise<WishlistShareStatus> {
  const response = await fetch(`${API_BASE_URL}/wishlist-share/rotate`, {
    method: "POST",
    headers: await getAuthHeaders(),
  });
  return handleResponse<WishlistShareStatus>(response);
}

/** Revoke the share link; it 404s immediately. */
export async function revokeWishlistShare(): Promise<WishlistShareStatus> {
  const response = await fetch(`${API_BASE_URL}/wishlist-share`, {
    method: "DELETE",
    headers: await getAuthHeaders(),
  });
  return handleResponse<WishlistShareStatus>(response);
}

/**
 * Anonymous read of a shared wishlist. Never sends auth headers. Throws `ApiError` (404 for an
 * unknown, rotated or revoked token or a disabled feature; 429 when rate-limited).
 */
export async function getPublicWishlist(token: string): Promise<PublicWishlistResponse> {
  const response = await fetch(`${API_BASE_URL}/wishlist/${encodeURIComponent(token)}`, {
    credentials: "omit",
    referrerPolicy: "no-referrer",
  });
  return handleResponse<PublicWishlistResponse>(response);
}
