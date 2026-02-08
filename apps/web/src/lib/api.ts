import type { Polish, PolishCreateRequest, PolishUpdateRequest, PolishListResponse } from "swatchwatch-shared";
import { MOCK_POLISHES } from "@/lib/mock-data";

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
  try {
    const response = await fetch(`${API_BASE_URL}/polishes`);
    return await handleResponse<PolishListResponse>(response);
  } catch {
    return {
      polishes: MOCK_POLISHES,
      total: MOCK_POLISHES.length,
      page: 1,
      pageSize: MOCK_POLISHES.length,
    };
  }
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
