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
