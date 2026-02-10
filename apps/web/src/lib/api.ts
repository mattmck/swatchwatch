import type {
  CaptureAnswerRequest,
  CaptureAnswerResponse,
  CaptureFinalizeResponse,
  CaptureFrameRequest,
  CaptureFrameResponse,
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

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:7071/api";

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

function getAuthHeaders(): Record<string, string> {
  if (process.env.NEXT_PUBLIC_AUTH_DEV_BYPASS === "true") {
    return { Authorization: "Bearer dev:1" };
  }
  // TODO: read real token from auth state once B2C is wired up
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
