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

/**
 * Non-Shopify sources registered disabled until the owner approves them. They are never
 * auto-provisioned (`isAutoProvisionableSource` is Shopify-only), so their migration is their
 * only registration and this set is bookkeeping: tests check each is seeded `enabled = false`
 * with `"pendingApproval": true`. Shopify stores use `SHOPIFY_SOURCES_PENDING_APPROVAL`
 * (lib/connectors/shopify-generic.ts), which also drives auto-provisioning.
 */
export const CONNECTOR_SOURCES_PENDING_APPROVAL: ReadonlySet<string> = new Set([
  // OPI brand store via sitemap + JSON-LD: no terms page at /terms-of-use on 2026-11-08; the
  // owner locates and reads the site terms and asks for the OK (brand sources plan, Task 15).
  "OpiSitemap",
  // WooCommerce Store API stores (brand sources plan, Task 16). Picture Polish: the Store API
  // answered 200 on 2026-11-08, terms not read yet. ILNP (robots.txt disallows the Store API) and
  // KBShimmer (Cloudflare challenge) are known-blocked (`metadata.blocked`), registered so the
  // admin console lists them.
  "PicturePolishWooCommerce",
  "IlnpWooCommerce",
  "KbshimmerWooCommerce",
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
