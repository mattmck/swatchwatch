import type { CANONICAL_FINISHES } from "../constants/finishes";
import type { ColorFamily } from "../color/color-family";
import type { ProductCategory } from "../constants/product-categories";
import type { ArchiveReason, PolishStatus } from "./inventory";

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
  /** Model self-reported confidence (0–1) for `detectedHex`; null/undefined when not recorded */
  detectedHexConfidence?: number | null;
  /** Detection strategy that produced `detectedHex` (`vision-direct`, `palette-pick`, `region-crop`, `ensemble`, `client-supplied`, …) */
  detectedHexMethod?: string | null;
  /** Azure OpenAI deployment name that produced `detectedHex` */
  detectedHexModel?: string | null;
  /** Prompt revision used for `detectedHex` (`PROMPT_VERSION` in the functions package) */
  detectedHexPromptVersion?: string | null;
  /** ISO-8601 time `detectedHex` was last written */
  detectedHexAt?: string | null;
  /**
   * OKLAB distance between `vendorHex` and `detectedHex` (null unless both exist).
   * Stored on the shade (`shade.hex_agreement`); > 0.10 (MEDIUM) counts as a disagreement.
   */
  hexAgreement?: number | null;
  /**
   * Color family derived from the display hex (vendor > detected > name), or
   * `multichrome` for color-shifting finishes. Stored on the shade as the generated
   * `shade.color_family` column; null when the shade has no usable hex.
   * See `classifyColorFamily`.
   */
  colorFamily?: ColorFamily | null;
  /**
   * OKLAB distance from the display hex to the nearest `nearHex` target (`GET /api/polishes?nearHex=`),
   * equal to `colorDistance(resolveDisplayHex(polish), target)`; grade it with the shared dupe
   * thresholds. Null when the shade has no usable display hex; absent when the request had no
   * `nearHex`.
   */
  colorDistance?: number | null;
  /**
   * What kind of product the shade is (`shade.product_category`, #349): `color`, `topper`,
   * `top_coat`, `base_coat`, `treatment` or `accessory`. Missing from older responses; treat
   * that as `color` (`resolveProductCategory`).
   */
  productCategory?: ProductCategory;
  /**
   * Legacy single finish (the shade's identity/primary finish). Kept populated for
   * backward compatibility; prefer `finishes` (or `resolvePolishFinishes`) for display.
   */
  finish?: FinishName;
  /** All finishes for the shade, primary first (e.g. `["shimmer", "holographic"]`). */
  finishes?: FinishName[];
  collection?: string;
  /**
   * True only when the shade is the caller's own private `user_submitted` shade (created by
   * them, not yet approved or merged): its creator may still correct brand, name, finishes and
   * color through `PUT /api/polishes/{id}` (catalog write rule, #224). Absent/false for catalog
   * shades and never true for another user's submission.
   */
  ownSubmitted?: boolean;
  quantity?: number;
  /**
   * Inventory status (`owned | wishlist | destash | archived`). Null/undefined when the caller
   * has no inventory row for this shade (a plain catalog entry).
   */
  status?: PolishStatus | null;
  /** Derived: `status === "owned"` and `triedAt` is null. False for catalog-only rows. */
  isUntried?: boolean;
  /** ISO-8601 time the user first tried the polish; null = never tried. */
  triedAt?: string | null;
  /** ISO-8601 time of the last logged wear (read-only for now; written by the mani log). */
  lastWornAt?: string | null;
  /** Number of logged wears (read-only for now). 0 for owned rows that were never worn. */
  wearCount?: number | null;
  /** Price paid per bottle (`user_inventory_item.purchase_price`, 2 decimals). */
  purchasePrice?: number | null;
  /** ISO 4217 currency code for `purchasePrice` (e.g. `USD`). */
  purchaseCurrency?: string | null;
  size?: string;
  purchaseDate?: string;
  expirationDate?: string;
  rating?: number;
  notes?: string;
  swatchImageUrl?: string;
  sourceImageUrls?: string[];
  /**
   * Reserved; not populated by the polishes API. The private on-nail photo is served by
   * `GET /api/inventory/{inventoryItemId}/nail-photo` (`NailPhotoResponse`, #270).
   */
  nailImageUrl?: string;
  /**
   * "Buy from brand" link: the stored source product URL (absolute http/https, no
   * credentials; validated server-side). Absent when the shade has no stored product URL.
   * When a shade has several source products the API picks one deterministically
   * (enabled source first, then most recently seen). No affiliate parameters.
   */
  buyUrl?: string;
  /**
   * The brand's list price for the `buyUrl` product (same chosen product), in major units
   * (e.g. `12.5`), as the connector last saw it. A vendor price, never the user's
   * `purchasePrice`. Present only together with `buyCurrency`; absent when the product has no
   * price or its store currency is unknown.
   */
  buyPrice?: number;
  /** ISO 4217 currency of `buyPrice` (e.g. `"USD"`); prices are never converted or summed across currencies. */
  buyCurrency?: string;
  /** When the connector fetched the product that `buyPrice` came from (ISO 8601). */
  buyPriceSeenAt?: string;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Returns the best available hex for display: vendor > detected > name.
 * See `resolveDisplayHexDetailed` (color/hex-reconciliation.ts) for the variant
 * that reports the source, vendor↔detected agreement and review flags.
 */
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
  /** detected_hex provenance (migration 20261017024958000_shade-detected-hex-provenance) */
  detected_hex_confidence?: number | null;
  detected_hex_method?: string | null;
  detected_hex_model?: string | null;
  detected_hex_prompt_version?: string | null;
  detected_hex_at?: string | null;
  /** OKLAB distance vendor_hex ↔ detected_hex (generated column) */
  hex_agreement?: number | null;
}

export interface PolishCreateRequest {
  /**
   * Optional shade id when attaching an existing catalog entry to a user's collection.
   * When omitted, a new shade (brand/name) will be created or matched by name.
   */
  shadeId?: string;
  brand: string;
  name: string;
  /**
   * Catalog fields: `color`, `vendorHex`, `detectedHex`, `nameHex`, `finish` and `finishes`
   * are written to the shared shade ONLY when this request creates it. Adopting, matching or
   * updating an existing shared shade never changes them (the caller's own private
   * `user_submitted` shade is the exception: its creator may correct them).
   */
  color: string;
  vendorHex?: string;
  detectedHex?: string;
  nameHex?: string;
  /** Legacy single finish. When `finishes` is omitted it is treated as `[finish]`. */
  finish?: FinishName;
  /**
   * Multi-finish list. The first entry is the primary finish (used for the legacy
   * `finish` column). Unknown values are ignored; aliases are normalized. Never derived
   * from `tags`.
   */
  finishes?: FinishName[];
  collection?: string;
  /**
   * Create only: a barcode scanned in Rapid Add for this polish (EAN-13 / UPC-A / UPC-E /
   * EAN-8, as decoded). Remembered on the resulting shade for the caller only, so their next
   * scan of the bottle matches; never written to the shared catalog. 400 when not a valid
   * GTIN. Ignored by PUT.
   */
  barcode?: string;
  /** Decoder format of `barcode` (`ean_13`, `upc_a`, `upc_e`, `ean_8`), used to read 8-digit codes. */
  barcodeFormat?: string;
  quantity?: number;
  /**
   * Inventory status. When omitted, a NEW inventory row is `owned` unless `quantity` is
   * exactly 0 (then `wishlist`, so clients that predate the status model keep working); an
   * existing row keeps its stored status. Nothing moves to the wishlist automatically:
   * running out sends `archived` (decision D5).
   */
  status?: PolishStatus;
  /**
   * Why the polish is archived; only allowed with `status: "archived"`. Recorded as an
   * `inventory_event` when the request archives the row (default `used_up` from owned,
   * `decluttered` from destash); sent again while already archived, it corrects the reason of
   * the current archive.
   */
  archiveReason?: ArchiveReason;
  /**
   * Undo of an archive (the toast's Undo): with a non-archived `status`, removes the reason
   * event recorded for the current archive. Not allowed with `status: "archived"` or
   * `archiveReason`.
   */
  undoArchive?: boolean;
  /** ISO-8601 date or date-time the polish was first tried; `null` clears it (back to untried). */
  triedAt?: string | null;
  /** Price paid, >= 0 with at most 2 decimals (max 99,999,999.99); `null` clears it. */
  purchasePrice?: number | null;
  /** ISO 4217 three-letter currency code (normalized to upper case); `null` clears it. */
  purchaseCurrency?: string | null;
  size?: string;
  /** `YYYY-MM-DD`; `null` clears it (a missing key keeps the stored value). */
  purchaseDate?: string | null;
  expirationDate?: string;
  /** Whole number 1-5; `null` clears it (a missing key keeps the stored value). */
  rating?: number | null;
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
  /** `collection` = only rows with `status === "owned"`. */
  scope?: "all" | "collection";
  /** Legacy alias: `owned` ≡ `status=owned`, `wishlist` ≡ `status=wishlist`. Prefer `status`. */
  availability?: "all" | "owned" | "wishlist";
  /** Only inventory rows with one of these statuses (sent as `status=owned,destash`). */
  status?: PolishStatus[];
  /** Only owned rows that were never tried (`untried=true`). */
  untried?: boolean;
  tone?: "warm" | "cool" | "neutral";
  /** Matches shades in ANY of these color families (`?family=red,pink`). */
  families?: ColorFamily[];
  /** Matches shades in ANY of these product categories (`?category=color,topper`). */
  categories?: ProductCategory[];
  /**
   * Rank by OKLAB distance from the display hex to the nearest of these colors (`#RRGGBB` or
   * `RRGGBB`, at most 24), nearest first; replaces `sortBy`/`sortOrder` and fills
   * `Polish.colorDistance`. Combines with every other filter and paging.
   */
  nearHex?: string[];
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
  /** Color family of the shade (see `Polish.colorFamily`). */
  colorFamily?: ColorFamily | null;
  /** Product category (see `Polish.productCategory`). */
  productCategory?: ProductCategory;
  similarity: number;
  /** "Buy from brand" link (see `Polish.buyUrl`); absent when none is stored. */
  buyUrl?: string;
  /** Brand list price for the buy link (see `Polish.buyPrice`); only with `buyCurrency`. */
  buyPrice?: number;
  buyCurrency?: string;
  buyPriceSeenAt?: string;
}

export interface CatalogSearchResponse {
  results: CatalogSearchResult[];
  query: string;
  total: number;
}

// Admin hex review (GET /api/polishes-admin/hex-review)

/** Sort order for the admin hex-review queue. */
export type HexReviewSort = "agreement" | "confidence";

export interface HexReviewItem {
  shadeId: string;
  brand: string;
  name: string;
  status: string;
  vendorHex: string | null;
  detectedHex: string | null;
  nameHex: string | null;
  detectedHexConfidence: number | null;
  detectedHexMethod: string | null;
  detectedHexModel: string | null;
  detectedHexPromptVersion: string | null;
  detectedHexAt: string | null;
  hexAgreement: number | null;
  /** Hex the app would display today (vendor > detected > name). */
  displayHex: string | null;
  /** Column `displayHex` came from. */
  displaySource: "vendor" | "detected" | "name" | "none";
  /** True when vendor and detected hexes disagree by more than the MEDIUM threshold. */
  flagged: boolean;
}

export interface HexReviewResponse {
  items: HexReviewItem[];
  total: number;
  page: number;
  pageSize: number;
  sort: HexReviewSort;
  /** OKLAB distance above which `flagged` is true (MEDIUM_CONFIDENCE_MAX_DISTANCE). */
  disagreementThreshold: number;
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
  /** Product category (see `Polish.productCategory`). */
  productCategory?: ProductCategory;
  aliases: string[];
  /** "Buy from brand" link (see `Polish.buyUrl`); absent when none is stored. */
  buyUrl?: string;
  /** Brand list price for the buy link (see `Polish.buyPrice`); only with `buyCurrency`. */
  buyPrice?: number;
  buyCurrency?: string;
  buyPriceSeenAt?: string;
}
