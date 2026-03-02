export interface Polish {
  /** Canonical shade identifier (global across all users) */
  id: string;
  /** Alias for clarity when joining with catalog/shade tables */
  shadeId: string;
  /** User-specific inventory row id (undefined when the user does not own it) */
  inventoryItemId?: string;
  userId: string;
  brand: string;
  name: string;
  color: string;
  /** Hex from vendor/retailer product data (e.g. Shopify variant options) */
  vendorHex?: string;
  /** Hex detected by AI from the product image */
  detectedHex?: string;
  /** Hex inferred from the product color name via AI or builtin lookup */
  nameHex?: string;
  finish?: PolishFinish;
  collection?: string;
  quantity?: number;
  size?: string;
  purchaseDate?: string;
  expirationDate?: string;
  rating?: number;
  notes?: string;
  swatchImageUrl?: string;
  sourceImageUrls?: string[];
  nailImageUrl?: string;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
}

/** Returns the best available hex for display: vendor > detected > name */
export function resolveDisplayHex(
  polish: Pick<Polish, "vendorHex" | "detectedHex" | "nameHex">
): string | undefined {
  return polish.vendorHex || polish.detectedHex || polish.nameHex || undefined;
}

export type PolishFinish =
  | "creme"
  | "shimmer"
  | "glitter"
  | "metallic"
  | "matte"
  | "jelly"
  | "holographic"
  | "holo"
  | "crushed holo"
  | "linear holo"
  | "scattered holo"
  | "duochrome"
  | "multichrome"
  | "flake"
  | "topper"
  | "sheer"
  | "magnetic"
  | "thermal"
  | "crelly"
  | "other";

// Canonical entities (from schema)
export interface Brand {
  brand_id: number;
  name_canonical: string;
}

export interface Shade {
  shade_id: number;
  brand_id: number;
  product_line_id?: number;
  shade_name_canonical: string;
  finish?: string;
  collection?: string;
  release_year?: number;
  status: string;
  color_name?: string;
  vendor_hex?: string;
  detected_hex?: string;
  name_hex?: string;
}

export interface PolishCreateRequest {
  /**
   * Optional shade id when attaching an existing catalog entry to a user's collection.
   * When omitted, a new shade (brand/name) will be created or matched by name.
   */
  shadeId?: string;
  brand: string;
  name: string;
  color: string;
  vendorHex?: string;
  detectedHex?: string;
  nameHex?: string;
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

export type PolishUpdateRequest = Partial<PolishCreateRequest>;

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
  scope?: "all" | "collection";
  availability?: "all" | "owned" | "wishlist";
  tone?: "warm" | "cool" | "neutral";
  sortBy?:
    | "name"
    | "brand"
    | "createdAt"
    | "rating"
    | "status"
    | "finish"
    | "collection";
  sortOrder?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}

// Catalog search types
export interface CatalogSearchResult {
  shadeId: string;
  brand: string;
  name: string;
  finish?: string;
  collection?: string;
  similarity: number;
}

export interface CatalogSearchResponse {
  results: CatalogSearchResult[];
  query: string;
  total: number;
}

export interface CatalogShadeDetail {
  shadeId: string;
  brand: string;
  brandId: string;
  name: string;
  finish?: string;
  collection?: string;
  releaseYear?: number;
  status: string;
  aliases: string[];
}
