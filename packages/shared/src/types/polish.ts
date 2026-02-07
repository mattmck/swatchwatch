export interface Polish {
  id: string;
  userId: string;
  brand: string;
  name: string;
  color: string;
  colorHex?: string;
  finish?: PolishFinish;
  collection?: string;
  quantity?: number;
  size?: string;
  purchaseDate?: string;
  expirationDate?: string;
  rating?: number;
  notes?: string;
  swatchImageUrl?: string;
  nailImageUrl?: string;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
}

export type PolishFinish =
  | "cream"
  | "shimmer"
  | "glitter"
  | "metallic"
  | "matte"
  | "jelly"
  | "holographic"
  | "duochrome"
  | "multichrome"
  | "flake"
  | "topper"
  | "sheer"
  | "other";

export interface PolishCreateRequest {
  brand: string;
  name: string;
  color: string;
  colorHex?: string;
  finish?: PolishFinish;
  collection?: string;
  quantity?: number;
  size?: string;
  purchaseDate?: string;
  expirationDate?: string;
  rating?: number;
  notes?: string;
  tags?: string[];
}

export interface PolishUpdateRequest extends Partial<PolishCreateRequest> {
  id: string;
}

export interface PolishListResponse {
  polishes: Polish[];
  total: number;
  page: number;
  pageSize: number;
}

export interface PolishFilters {
  brand?: string;
  finish?: PolishFinish;
  color?: string;
  tags?: string[];
  search?: string;
  sortBy?: "name" | "brand" | "createdAt" | "rating";
  sortOrder?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}
