import type { Polish, PolishCreateRequest, PolishUpdateRequest, PolishListResponse } from "swatchwatch-shared";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:7071/api";

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Unknown error" }));
    throw new ApiError(response.status, error.error || error.message || "Request failed");
  }
  return response.json();
}

export async function listPolishes(): Promise<PolishListResponse> {
  const response = await fetch(`${API_BASE_URL}/polishes`);
  return handleResponse<PolishListResponse>(response);
}

export async function getPolish(id: string | number): Promise<Polish> {
  const response = await fetch(`${API_BASE_URL}/polishes/${id}`);
  return handleResponse<Polish>(response);
}

export async function createPolish(data: PolishCreateRequest): Promise<Polish> {
  const response = await fetch(`${API_BASE_URL}/polishes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  return handleResponse<Polish>(response);
}

export async function updatePolish(id: string | number, data: PolishUpdateRequest): Promise<Polish> {
  const response = await fetch(`${API_BASE_URL}/polishes/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  return handleResponse<Polish>(response);
}

export async function deletePolish(id: string | number): Promise<{ message: string; id: number }> {
  const response = await fetch(`${API_BASE_URL}/polishes/${id}`, {
    method: "DELETE",
  });
  return handleResponse<{ message: string; id: number }>(response);
}
