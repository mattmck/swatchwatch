import type { ProductCategory, ProductCategorySource } from "../constants/product-categories";

/**
 * Product-category backfill and admin override (#349, #347; decision D23).
 *
 * `POST /api/shades-admin/product-category/backfill` re-classifies every unmerged shade with the
 * shared classifier. Dry run by default: it returns this report and changes nothing. With
 * `dryRun: false` it applies the same changes in one transaction and records each one in
 * `shade_category_change` under the report's `runId`.
 */

/** Request body of the backfill endpoint. */
export interface ProductCategoryBackfillRequest {
  /** Default true: report only. */
  dryRun?: boolean;
  /**
   * Default false. Also clear `detected_hex` (and its provenance) on toppers whose detected hex
   * looks like the base color underneath (audit section 5). The old values are recorded so the
   * change can be undone.
   */
  clearTopperDetectedHex?: boolean;
}

/** A shade named in the report. */
export interface ProductCategoryReportShade {
  shadeId: string;
  brand: string;
  name: string;
  status: string;
}

export interface ProductCategoryChangeItem extends ProductCategoryReportShade {
  from: ProductCategory;
  to: ProductCategory;
  /** Which signal decided the new category (`text`, `type-tag`, `finish`, `tag`). */
  evidence: string | null;
}

export interface HeldAccessoryItem extends ProductCategoryReportShade {
  /** Distinct users holding the shade in their inventory (any status). */
  holders: number;
  productCategorySource: ProductCategorySource;
}

export interface TopperHexCandidate extends ProductCategoryReportShade {
  vendorHex: string | null;
  detectedHex: string;
  /** OKLAB distance vendor ↔ detected (null without a vendor hex). */
  vendorVsDetected: number | null;
  detectedHexMethod: string | null;
}

export interface ProductCategoryBackfillReport {
  dryRun: boolean;
  clearTopperDetectedHex: boolean;
  /** Groups the `shade_category_change` rows an applied run wrote; null for a dry run. */
  runId: string | null;
  scannedShades: number;
  /** Shades per final category: total, `status = 'active'`, held in someone's inventory. */
  byCategory: Record<ProductCategory, { shades: number; active: number; held: number }>;
  /** Shades per final category and category source. */
  byCategorySource: Array<{ category: ProductCategory; source: ProductCategorySource; shades: number }>;
  /** Non-color shades per data source (a shade with several sources counts under each). */
  byDataSource: Array<{ dataSource: string; category: ProductCategory; shades: number }>;
  /** Category transitions the run makes (from → to). */
  transitions: Array<{ from: ProductCategory; to: ProductCategory; shades: number }>;
  categoryChanges: ProductCategoryChangeItem[];
  /** Admin-set categories the rule disagrees with (left alone). */
  adminDisagreements: ProductCategoryChangeItem[];
  /** Accessories nobody holds that the run sets to `status = 'excluded'`. */
  excluded: ProductCategoryReportShade[];
  /** Accessories someone holds: never excluded, listed for admin review. */
  heldAccessories: HeldAccessoryItem[];
  /** Toppers decided only by a `topper(s)` tag (tags are noisy; review these). */
  topperByTagOnly: ProductCategoryReportShade[];
  /** Toppers whose detected hex may be the base color (cleared only with `clearTopperDetectedHex`). */
  topperHexCandidates: TopperHexCandidate[];
  /** Rows written (0 for a dry run). */
  applied: { category: number; exclude: number; clearDetectedHex: number };
}

/** `PUT /api/shades-admin/{shadeId}/product-category` */
export interface ShadeProductCategoryUpdateRequest {
  productCategory: ProductCategory;
}

export interface ShadeProductCategoryUpdateResponse {
  shadeId: string;
  productCategory: ProductCategory;
  productCategorySource: ProductCategorySource;
  /** Status after the change (an excluded shade set to a non-accessory category is `active` again). */
  status: string;
}

/** One row of `GET /api/shades-admin/product-category` (the admin category browser). */
export interface ShadeProductCategoryItem extends ProductCategoryReportShade {
  productCategory: ProductCategory;
  productCategorySource: ProductCategorySource;
  holders: number;
}

export interface ShadeProductCategoryListResponse {
  items: ShadeProductCategoryItem[];
  total: number;
  page: number;
  pageSize: number;
}
