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
  Polish,
  PolishCreateRequest,
  PolishUpdateRequest,
  PolishListResponse,
  PolishFilters,
  CatalogSearchResponse,
  CatalogShadeDetail,
} from "swatchwatch-shared";

import { getAccessToken } from "./auth-token";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:7071/api";
const MAX_CAPTURE_FRAME_BYTES = 5 * 1024 * 1024;

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

function getAuthHeaders(options?: { admin?: boolean }): Record<string, string> {
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
  if (filters?.tags?.length) params.set("tags", filters.tags.join(","));
  if (filters?.sortBy) params.set("sortBy", filters.sortBy);
  if (filters?.sortOrder) params.set("sortOrder", filters.sortOrder);
  if (filters?.page) params.set("page", String(filters.page));
  if (filters?.pageSize) params.set("pageSize", String(filters.pageSize));

  const qs = params.toString();
  const url = `${API_BASE_URL}/polishes${qs ? `?${qs}` : ""}`;

  const response = await fetch(url, { headers: getAuthHeaders() });
  return handleResponse<PolishListResponse>(response);
}

/**
 * Fetch all polish rows for the current user by walking paginated API results.
 * The API currently returns paginated responses (default pageSize=50).
 */
export async function listAllPolishes(
  filters?: Omit<PolishFilters, "page" | "pageSize"> & { pageSize?: number }
): Promise<Polish[]> {
  const pageSize = Math.min(100, Math.max(1, filters?.pageSize ?? 100));
  const allPolishes: Polish[] = [];
  let currentPage = 1;
  let total = 0;

  do {
    const response = await listPolishes({
      ...filters,
      page: currentPage,
      pageSize,
    });

    allPolishes.push(...response.polishes);
    total = response.total;
    currentPage += 1;

    if (response.polishes.length === 0) {
      break;
    }
  } while (allPolishes.length < total);

  // Defensive de-dupe by inventory item id in case of overlapping pages.
  return Array.from(
    new Map(allPolishes.map((polish) => [polish.id, polish])).values()
  );
}

export async function getPolish(id: string | number): Promise<Polish> {
  const response = await fetch(`${API_BASE_URL}/polishes/${id}`, {
    headers: getAuthHeaders(),
  });
  return handleResponse<Polish>(response);
}

export async function createPolish(data: PolishCreateRequest): Promise<Polish> {
  const response = await fetch(`${API_BASE_URL}/polishes`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getAuthHeaders() },
    body: JSON.stringify(data),
  });
  return handleResponse<Polish>(response);
}

export async function updatePolish(id: string | number, data: PolishUpdateRequest): Promise<Polish> {
  const response = await fetch(`${API_BASE_URL}/polishes/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...getAuthHeaders() },
    body: JSON.stringify(data),
  });
  return handleResponse<Polish>(response);
}

export async function deletePolish(id: string | number): Promise<{ message: string; id: number }> {
  const response = await fetch(`${API_BASE_URL}/polishes/${id}`, {
    method: "DELETE",
    headers: getAuthHeaders(),
  });
  return handleResponse<{ message: string; id: number }>(response);
}

export interface RecalcPolishHexResponse {
  message?: string;
  shadeId?: string;
  shadeName?: string;
  previousHex?: string | null;
  detectedHex?: string | null;
  confidence?: number | null;
  finishes?: string[] | null;
}

export async function recalcPolishHex(id: string | number): Promise<RecalcPolishHexResponse> {
  const response = await fetch(`${API_BASE_URL}/polishes/${id}/recalc-hex`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getAuthHeaders({ admin: true }) },
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
    headers: getAuthHeaders({ admin: true }),
  });

  return handleResponse<IngestionJobListResponse>(response);
}

export async function runIngestionJob(
  data: IngestionJobRunRequest
): Promise<IngestionJobRunResponse> {
  const response = await fetch(`${API_BASE_URL}/ingestion/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getAuthHeaders({ admin: true }) },
    body: JSON.stringify(data),
  });
  return handleResponse<IngestionJobRunResponse>(response);
}

export async function getIngestionJob(id: string | number): Promise<IngestionJobRunResponse> {
  const response = await fetch(`${API_BASE_URL}/ingestion/jobs/${id}`, {
    headers: getAuthHeaders({ admin: true }),
  });
  return handleResponse<IngestionJobRunResponse>(response);
}

export async function cancelIngestionJob(
  id: string | number,
  reason?: string
): Promise<IngestionJobRunResponse> {
  const response = await fetch(`${API_BASE_URL}/ingestion/jobs/${id}/cancel`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", ...getAuthHeaders({ admin: true }) },
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
    headers: getAuthHeaders({ admin: true }),
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
    headers: getAuthHeaders({ admin: true }),
  });
  return handleResponse<GlobalSettingsResponse>(response);
}

export async function updateGlobalSettings(settings: Partial<IngestionSettings>): Promise<GlobalSettingsResponse> {
  const response = await fetch(`${API_BASE_URL}/ingestion/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...getAuthHeaders({ admin: true }) },
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
    headers: { "Content-Type": "application/json", ...getAuthHeaders({ admin: true }) },
    body: JSON.stringify(settings),
  });
  return handleResponse<{ success: boolean }>(response);
}

export async function startCapture(data?: CaptureStartRequest): Promise<CaptureStartResponse> {

  const response = await fetch(`${API_BASE_URL}/capture/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getAuthHeaders() },
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
    headers: { "Content-Type": "application/json", ...getAuthHeaders() },
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
    headers: getAuthHeaders(),
  });
  return handleResponse<CaptureFinalizeResponse>(response);
}

export async function getCaptureStatus(captureId: string): Promise<CaptureStatusResponse> {
  const response = await fetch(`${API_BASE_URL}/capture/${captureId}/status`, {
    headers: getAuthHeaders(),
  });
  return handleResponse<CaptureStatusResponse>(response);
}

export async function answerCaptureQuestion(
  captureId: string,
  data: CaptureAnswerRequest
): Promise<CaptureAnswerResponse> {
  const response = await fetch(`${API_BASE_URL}/capture/${captureId}/answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getAuthHeaders() },
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
    headers: getAuthHeaders({ admin: true }),
  });
  return handleResponse<QueueStatsResponse>(response);
}

export async function purgeQueue(): Promise<QueuePurgeResponse> {
  const response = await fetch(`${API_BASE_URL}/ingestion/queue/messages`, {
    method: "DELETE",
    headers: getAuthHeaders({ admin: true }),
  });
  return handleResponse<QueuePurgeResponse>(response);
}
