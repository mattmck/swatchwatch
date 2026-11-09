import type { SourceSettings } from "../../source-settings.js";

/** The raw Shopify product fields a store-specific filter may read. */
export interface StoreFilterProduct {
  title?: unknown;
  product_type?: unknown;
  tags?: unknown;
  handle?: unknown;
  body_html?: unknown;
  variants?: unknown;
  vendor?: unknown;
}

/**
 * A store-specific polish filter: `true` keeps the product, `false` drops it,
 * `null` defers to the generic polish filter. A settings-aware filter (Beyond Polish's
 * `includeGel`) reads the source's `data_source.metadata` settings; the rest ignore them. The
 * settings are absent when a caller has none (a unit test, a source without settings).
 */
export type StoreProductFilter = (
  product: StoreFilterProduct,
  settings?: SourceSettings
) => boolean | null;

/**
 * A store-specific shade-name parser for stores whose product title is not the shade
 * name (retailers). Returns the shade name, or `null` to keep the raw title.
 */
export type StoreTitleParser = (
  product: StoreFilterProduct & { vendor?: unknown }
) => string | null;
