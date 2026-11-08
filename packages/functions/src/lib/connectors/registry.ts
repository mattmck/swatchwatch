/**
 * Connector protocol registry: which protocol a source speaks, whether that protocol can be
 * ingested, and whether its records become catalog shades. The protocol of each source comes
 * from SOURCE_PROTOCOL_MAP, generated from docs/seed_data_sources.sql by
 * scripts/generate-connector-types.mjs (suffix rules: `Shopify`, `Feed`, `Sitemap`,
 * `WooCommerce`, `BigCartel`).
 */

import type { ConnectorProtocol } from "swatchwatch-shared";
import { SOURCE_PROTOCOL_MAP, type SupportedConnectorSource } from "./generated-types";

/** Protocols the ingestion pipeline can run (some may not have a connector factory yet). */
const RUNNABLE_PROTOCOLS: ReadonlySet<ConnectorProtocol> = new Set<ConnectorProtocol>([
  "HoloTaco",
  "Shopify",
  "OpenBeautyFacts",
  "MakeupAPI",
  "ProductFeed",
  "SitemapJsonLd",
  "WooCommerce",
  "BigCartel",
]);

/**
 * Runnable protocols whose records are not shade products: OpenBeautyFacts and MakeupAPI have
 * their own materializers instead of `materializeHoloTacoRecords`.
 */
const NON_SHADE_PRODUCT_PROTOCOLS: ReadonlySet<ConnectorProtocol> = new Set<ConnectorProtocol>([
  "OpenBeautyFacts",
  "MakeupAPI",
]);

export function protocolOf(source: SupportedConnectorSource): ConnectorProtocol {
  return SOURCE_PROTOCOL_MAP[source] ?? "Custom";
}

export function isRunnableProtocol(protocol: ConnectorProtocol): boolean {
  return RUNNABLE_PROTOCOLS.has(protocol);
}

/** True when the source's records are shade products materialized into the catalog. */
export function materializesShadeProducts(source: SupportedConnectorSource): boolean {
  const protocol = protocolOf(source);
  return isRunnableProtocol(protocol) && !NON_SHADE_PRODUCT_PROTOCOLS.has(protocol);
}

/**
 * The protocol of any `data_source.name` (a DB row, a backfill argument): `protocolOf` for a
 * seeded connector source, `Custom` for any other name.
 */
export function protocolOfName(name: string): ConnectorProtocol {
  return Object.prototype.hasOwnProperty.call(SOURCE_PROTOCOL_MAP, name)
    ? protocolOf(name as SupportedConnectorSource)
    : "Custom";
}

/**
 * True for a source whose raw products are Shopify `products.json` products: the generic Shopify
 * stores and Holo Taco (its own protocol, the same payload). Replaces the old
 * `name.endsWith("Shopify")` checks, so a `…Feed`, `…Sitemap`, `…WooCommerce` or `…BigCartel`
 * source never takes a Shopify branch.
 */
export function isShopifyProductsSource(name: string): boolean {
  const protocol = protocolOfName(name);
  return protocol === "Shopify" || protocol === "HoloTaco";
}
