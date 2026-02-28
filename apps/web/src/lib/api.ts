import type {
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
  Polish,
  PolishCreateRequest,
  PolishUpdateRequest,
  PolishListResponse,
  PolishFilters,
  CatalogSearchResponse,
  CatalogShadeDetail,
  PolishFinish,
  FinishType,
  FinishNormalization,
  FinishNormalizationCreateRequest,
  FinishNormalizationListResponse,
  FinishNormalizationUpdateRequest,
  FinishTypeCreateRequest,
  FinishTypeUpdateRequest,
  FinishTypeListResponse,
  ReferenceHarmonyType,
  HarmonyTypeCreateRequest,
  HarmonyTypeUpdateRequest,
  HarmonyTypeListResponse,
  IngestionJob,
} from "swatchwatch-shared";

import { getAccessToken } from "./auth-token";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:7071/api";
const MAX_CAPTURE_FRAME_BYTES = 5 * 1024 * 1024;
const LIST_ALL_POLISHES_PAGE_SIZE = 250;
const listPolishesInFlight = new Map<string, Promise<PolishListResponse>>();

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

async function getAuthHeaders(options?: { admin?: boolean }): Promise<Record<string, string>> {
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
    throw new ApiError(response.status, error.error || error.message || "Request failed");
  }
  return response.json();
}

export async function listPolishes(filters?: PolishFilters): Promise<PolishListResponse> {
  const params = new URLSearchParams();

  if (filters?.search) params.set("search", filters.search);
  if (filters?.brand) params.set("brand", filters.brand);
  if (filters?.finish) params.set("finish", filters.finish);
  if (filters?.scope && filters.scope !== "all") params.set("scope", filters.scope);
  if (filters?.availability && filters.availability !== "all") {
    params.set("availability", filters.availability);
  }
  if (filters?.tone) params.set("tone", filters.tone);
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

export async function searchCatalog(q: string, limit?: number): Promise<CatalogSearchResponse> {
  const params = new URLSearchParams({ q });
  if (limit) params.set("limit", String(limit));

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

/** Update a finish reference row via `PUT /api/reference-admin/finishes/{id}` (admin auth required). */
export async function updateFinishType(
  finishTypeId: number,
  data: FinishTypeUpdateRequest
): Promise<FinishType> {
  const response = await fetch(`${API_BASE_URL}/reference-admin/finishes/${finishTypeId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...await getAuthHeaders({ admin: true }) },
    body: JSON.stringify(data),
  });
  return handleResponse<FinishType>(response);
}

/** Delete a finish reference row via `DELETE /api/reference-admin/finishes/{id}` (admin auth required). */
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
