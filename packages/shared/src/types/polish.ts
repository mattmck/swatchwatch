import type { CANONICAL_FINISHES } from "../constants/finishes";

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
  /**
   * Legacy single finish (the shade's identity/primary finish). Kept populated for
   * backward compatibility; prefer `finishes` (or `resolvePolishFinishes`) for display.
   */
  finish?: FinishName;
  /** All finishes for the shade, primary first (e.g. `["shimmer", "holographic"]`). */
  finishes?: FinishName[];
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

/** A built-in finish name, derived from the `CANONICAL_FINISHES` seeded-defaults list. */
export type PolishFinish = (typeof CANONICAL_FINISHES)[number];

/**
 * Any finish name the API accepts or returns: the built-in `PolishFinish` names (kept for
 * editor autocomplete) plus runtime names from admin-managed `finish_type` rows.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export type FinishName = PolishFinish | (string & {});

/**
 * Returns the finishes to display for a polish: the multi-finish `finishes` list when
 * present, otherwise the legacy single `finish` (so older payloads keep rendering).
 */
export function resolvePolishFinishes(
  polish: { finish?: string | null; finishes?: readonly string[] | null }
): string[] {
  const out: string[] = [];
  const push = (value: string | null | undefined) => {
    const trimmed = value?.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  };
  if (polish.finishes && polish.finishes.length > 0) {
    polish.finishes.forEach(push);
  } else {
    push(polish.finish);
  }
  return out;
}

/** True when the polish has `finish` among its finishes (case-insensitive). */
export function polishHasFinish(
  polish: { finish?: string | null; finishes?: readonly string[] | null },
  finish: string
): boolean {
  const target = finish.trim().toLowerCase();
  if (!target) return false;
  return resolvePolishFinishes(polish).some((value) => value.toLowerCase() === target);
}

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
  /** Canonical multi-finish list (`shade.finishes text[]`). */
  finishes?: string[];
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
  /** Legacy single finish. When `finishes` is omitted it is treated as `[finish]`. */
  finish?: FinishName;
  /**
   * Multi-finish list. The first entry is the primary finish (used for the legacy
   * `finish` column). Unknown values are ignored; aliases are normalized.
   */
  finishes?: FinishName[];
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
  /** Matches shades that have this finish among their finishes (or as the legacy `finish`). */
  finish?: FinishName;
  /** Matches shades that have ANY of these finishes. */
  finishes?: FinishName[];
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
  finishes?: string[];
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
  finishes?: string[];
  collection?: string;
  releaseYear?: number;
  status: string;
  aliases: string[];
}
