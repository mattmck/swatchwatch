// Auto-generated from docs/seed_data_sources.sql
// Do not edit manually - run "node scripts/generate-connector-types.mjs" to regenerate
import type { SupportedConnectorSource } from "./generated-types";
import { SOURCE_PROTOCOL_MAP, SUPPORTED_SOURCES } from "./generated-types";

export type { SupportedConnectorSource };
export { SOURCE_PROTOCOL_MAP, SUPPORTED_SOURCES };

/**
 * Reuses a connector's raw catalog download across the pages and continuation invocations
 * of one ingestion job. Connectors that download a whole catalog per pull (Shopify) use it;
 * others ignore it.
 */
export interface ConnectorCatalogCache {
  /** Previously saved raw products, or null when nothing is cached (or the cache is unreadable). */
  load(): Promise<unknown[] | null>;
  save(products: unknown[]): Promise<void>;
}

export interface ConnectorPullOptions {
  searchTerm: string;
  page: number;
  pageSize: number;
  maxRecords: number;
  recentDays?: number;
  catalogCache?: ConnectorCatalogCache;
}

/** Load the raw catalog from `cache` when present, otherwise fetch it and save it to `cache`. */
export async function loadCatalogWithCache<T>(
  cache: ConnectorCatalogCache | undefined,
  fetchCatalog: () => Promise<T[]>
): Promise<T[]> {
  const cached = cache ? await cache.load() : null;
  // An empty snapshot is more likely truncated than a store with no products; refetch.
  if (cached && cached.length > 0) {
    return cached as T[];
  }

  const products = await fetchCatalog();
  await cache?.save(products);
  return products;
}

/**
 * A connector's `normalized` record (stored as `external_product.normalized_json`). Fields are
 * connector-specific; the ones every connector writes are typed here.
 */
export interface ConnectorNormalizedProduct extends Record<string, unknown> {
  /**
   * Vendor product description as plain text (HTML stripped, capped; `lib/product-text.ts`),
   * or null. Used for finish detection only, never returned to users (#352). Optional because
   * rows ingested before #352 lack it until `npm run backfill:product-text` runs.
   */
  descriptionText?: string | null;
  /** Product type, variant options, tags, collection names, deduped and capped (#352). */
  descriptors?: string[];
  /**
   * Brand list price in major units as a decimal string (`"12.50"`), or null; written by the
   * connectors whose data has one (Shopify-style stores, MakeupAPI; `lib/product-price.ts`).
   * Feeds `buyPrice` on the buy link. Rows ingested earlier get it from
   * `npm run backfill:product-price`.
   */
  price?: string | null;
  /** ISO 4217 code of `price`, or null when the store currency is unknown (never guessed). */
  currency?: string | null;
}

export interface ConnectorProductRecord {
  externalId: string;
  gtin?: string | null;
  raw: Record<string, unknown>;
  normalized: ConnectorNormalizedProduct;
  etag?: string | null;
}

export interface ConnectorPullResult {
  source: SupportedConnectorSource;
  records: ConnectorProductRecord[];
  metadata: Record<string, unknown>;
}

export interface ProductConnector {
  source: SupportedConnectorSource;
  pullProducts(options: ConnectorPullOptions): Promise<ConnectorPullResult>;
}
