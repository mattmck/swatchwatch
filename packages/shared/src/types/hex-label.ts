/**
 * Admin Hex Labeling tool (admin console tab "Hex Labeling"): hand-picked
 * ground-truth hexes sampled with an eyedropper from a shade's product images.
 * Stored as `color_training_sample` rows with `source_type = 'manual'` and
 * exported by `npm run eval:hex:populate` as `manual` eval cases.
 *
 * Routes (admin-only): `GET /api/hex-labels-admin/queue`, `GET /api/hex-labels-admin/shades/{shadeId}`
 * (one `HexLabelQueueItem`, for the polish detail page),
 * `POST /api/hex-labels-admin/labels`, `DELETE /api/hex-labels-admin/labels/{trainingSampleId}`,
 * `POST|DELETE /api/hex-labels-admin/labels/{trainingSampleId}/promote` and
 * `DELETE /api/hex-labels-admin/shades/{shadeId}/promotion` (promote a label to `shade.vendor_hex`
 * and undo it, #321 / decision D12).
 */

import type { ProductCategory, ProductCategorySource } from "../constants/product-categories";

/**
 * Where `shade.vendor_hex` came from (`shade.vendor_hex_source`, #321): `vendor` = vendor/catalog
 * data, `manual_label` = an admin promoted the shade's manual label. Ingestion never overwrites a
 * `manual_label` hex. Admin-only: not part of user-facing polish responses.
 */
export const VENDOR_HEX_SOURCES = ["vendor", "manual_label"] as const;
export type VendorHexSource = (typeof VENDOR_HEX_SOURCES)[number];

/**
 * Where `shade.finishes` came from (`shade.finishes_source`): `rule` = ingestion / backfills,
 * `admin` = set in the Hex Labeling tool with `PUT /api/shades-admin/{shadeId}/finishes`.
 * Ingestion and the product-text backfill never change an `admin` list. Admin-only.
 */
export const FINISHES_SOURCES = ["rule", "admin"] as const;
export type FinishesSource = (typeof FINISHES_SOURCES)[number];

/** Most finishes an admin can set on one shade. */
export const SHADE_FINISHES_MAX = 8;

/** How the labelled hex was picked. */
export type HexLabelSampleMethod = "canvas" | "eyedropper" | "manual";

/**
 * Averaging window sizes (pixels per side) the canvas eyedropper offers. Odd so the window stays
 * centred on the pointer. The large windows (15–61) average across glitter, flakies and shimmer,
 * where a small window lands on a single particle or a bare patch of base.
 */
export const HEX_LABEL_SAMPLE_SIZES = [1, 3, 5, 9, 15, 25, 41, 61] as const;
export type HexLabelSampleSize = (typeof HEX_LABEL_SAMPLE_SIZES)[number];

/** Where on the image a canvas sample was taken. x/y are normalized 0..1 to the natural image size. */
export interface HexLabelSamplePoint {
  x: number;
  y: number;
  /** Averaging window (pixels per side) around the point. */
  size: number;
  /** Natural image size in pixels when the sample was taken. */
  imageWidth: number;
  imageHeight: number;
}

/** One catalog product image of a shade, served through the signed image proxy. */
export interface HexLabelImage {
  /** `image_asset.image_id`. */
  imageId: string;
  /** Readable URL (`/api/images/{id}` capability, public v2 scope). */
  url: string;
  /** `swatch.swatch_type`, e.g. `source_product` (primary) or `source_gallery`. */
  swatchType: string | null;
  /** Vendor CDN URL the image was downloaded from (`source_image_url`), when known. */
  sourceUrl: string | null;
  /** True for the shade's primary product image. */
  isPrimary: boolean;
}

/** A saved manual label (`color_training_sample` row, `source_type = 'manual'`). */
export interface HexLabel {
  trainingSampleId: string;
  shadeId: string;
  /** Picked hex (`#RRGGBB`); null only when `unreliable`. */
  hex: string | null;
  /** True when the admin flagged the shade's images as unusable (`training_status = 'rejected'`). */
  unreliable: boolean;
  /** Image the hex was sampled from. */
  imageId: string | null;
  note: string | null;
  method: HexLabelSampleMethod | null;
  samplePoint: HexLabelSamplePoint | null;
  labeledByUserId: string | null;
  labeledAt: string;
}

export interface HexLabelQueueItem {
  shadeId: string;
  brand: string;
  name: string;
  finishes: string[];
  /** Provenance of `finishes`; `admin` lists are never changed by ingestion. */
  finishesSource: FinishesSource;
  /** `shade.product_category`; the queue only lists `color` shades. */
  productCategory: ProductCategory;
  productCategorySource: ProductCategorySource;
  vendorHex: string | null;
  detectedHex: string | null;
  nameHex: string | null;
  /** OKLAB distance vendor ↔ detected (`shade.hex_agreement`), null unless both exist. */
  hexAgreement: number | null;
  detectedHexConfidence: number | null;
  detectedHexMethod: string | null;
  /** True when `hexAgreement` exceeds the MEDIUM threshold. */
  flagged: boolean;
  /** Catalog images (primary first). Private user media is never included. */
  images: HexLabelImage[];
  /** The shade's current manual label, if any. */
  label: HexLabel | null;
  /** Provenance of `vendorHex`; null = unknown / no vendor hex. */
  vendorHexSource: VendorHexSource | null;
  /**
   * The label promoted to `vendorHex` when `vendorHexSource` is `manual_label`; null when none, or
   * when the promoted label was deleted afterwards (the promoted hex is kept).
   */
  promotedLabelId: string | null;
  /** Vendor hex a promotion replaced (restored by Undo); null when not promoted or there was none. */
  vendorHexPrevious: string | null;
}

export interface HexLabelQueueFilters {
  /** Brand name substring (case-insensitive). */
  brand?: string;
  /** Only shades whose vendor and detected hexes disagree (`hex_agreement > 0.10`). */
  disagreeOnly?: boolean;
  /** Include shades that already have a manual label (listed after unlabeled ones). */
  showLabeled?: boolean;
  /** Include shades without any catalog image (listed after shades with images). */
  includeWithoutImages?: boolean;
  /** Opaque cursor from a previous response's `nextCursor`. */
  cursor?: string;
  /** Page size (default 20, max 100). */
  pageSize?: number;
}

export interface HexLabelQueueResponse {
  items: HexLabelQueueItem[];
  /** Cursor for the next page, or null at the end of the queue. */
  nextCursor: string | null;
  /** Shades matching the brand/disagreement/image filters (labeled or not). */
  total: number;
  /** How many of `total` already have a manual label. */
  labeled: number;
  pageSize: number;
  /** OKLAB distance above which `flagged` is true (MEDIUM_CONFIDENCE_MAX_DISTANCE). */
  disagreementThreshold: number;
}

/** Body of `POST /api/hex-labels-admin/labels` (create or replace the shade's manual label). */
export interface HexLabelRequest {
  shadeId: string;
  /** `#RRGGBB`; required unless `unreliable`. */
  hex?: string | null;
  /** Image the hex was sampled from; must be one of the shade's catalog images. */
  imageId?: string | null;
  /** Flag the shade's images as unusable for ground truth (stored as `rejected`). */
  unreliable?: boolean;
  /** Free-text note (max 1000 characters). */
  note?: string | null;
  method?: HexLabelSampleMethod | null;
  samplePoint?: HexLabelSamplePoint | null;
}

export interface HexLabelSaveResponse {
  label: HexLabel;
  /** The label this save replaced, so the client can undo by restoring it. */
  previous: HexLabel | null;
}

export interface HexLabelDeleteResponse {
  deleted: string;
}

/**
 * Response of `POST /api/hex-labels-admin/labels/{id}/promote` and of the two undo routes
 * (`DELETE .../labels/{id}/promote`, `DELETE .../shades/{shadeId}/promotion`).
 */
export interface HexLabelPromoteResponse {
  shadeId: string;
  vendorHex: string | null;
  vendorHexSource: VendorHexSource | null;
  promotedLabelId: string | null;
  vendorHexPrevious: string | null;
  /** False when the request changed nothing (repeat promote, or undo with nothing promoted). */
  changed: boolean;
}

/**
 * Body of `PUT /api/shades-admin/{shadeId}/finishes` (admin-only): the shade's whole finish list,
 * primary first. Every entry must be a known finish or alias (`finish_type` / `finish_normalization`);
 * an empty list is allowed. The list becomes sticky (`finishesSource = 'admin'`).
 */
export interface ShadeFinishesUpdateRequest {
  finishes: string[];
}

export interface ShadeFinishesUpdateResponse {
  shadeId: string;
  /** Canonical finish names as stored, primary first. */
  finishes: string[];
  finishesSource: FinishesSource;
  /** False when the list was already exactly this (nothing written, nothing logged). */
  changed: boolean;
}
