/** The raw Shopify product fields a store-specific filter may read. */
export interface StoreFilterProduct {
  title?: unknown;
  product_type?: unknown;
  tags?: unknown;
  handle?: unknown;
  body_html?: unknown;
  variants?: unknown;
}

/**
 * A store-specific polish filter: `true` keeps the product, `false` drops it,
 * `null` defers to the generic polish filter.
 */
export type StoreProductFilter = (product: StoreFilterProduct) => boolean | null;

/**
 * A store-specific shade-name parser for stores whose product title is not the shade
 * name (retailers). Returns the shade name, or `null` to keep the raw title.
 */
export type StoreTitleParser = (
  product: StoreFilterProduct & { vendor?: unknown }
) => string | null;
