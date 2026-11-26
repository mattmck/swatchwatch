import type { ConnectorProtocol } from "swatchwatch-shared";
// Connector modules are imported as "../connectors/<name>" (not "./<name>") so their request
// ends in "connectors/<name>", the key the worker unit tests mock them by.
import { OpenBeautyFactsConnector } from "../connectors/open-beauty-facts";
import { MakeupApiConnector } from "../connectors/makeup-api";
import { HoloTacoShopifyConnector } from "../connectors/holo-taco-shopify";
import { ShopifyGenericConnector } from "../connectors/shopify-generic";
import { assertAuthedFeedUsesHttps, ProductFeedConnector } from "../connectors/product-feed";
import { WooCommerceStoreConnector } from "../connectors/woocommerce-store";
import { SitemapJsonLdConnector } from "../connectors/sitemap-jsonld";
import { BigCartelConnector } from "../connectors/big-cartel";
import { ProductConnector, SupportedConnectorSource, SUPPORTED_SOURCES } from "./types";
import { protocolOf } from "./registry";
import type { SourceSettings } from "../source-settings";

/**
 * Connector factories: which sources the ingestion worker can actually run. Shared by the
 * ingestion endpoints (single job, bulk, source list) and the nightly catalog refresh timer
 * (#532), so "runnable" means the same thing everywhere.
 */

export function isSupportedSource(value: string): value is SupportedConnectorSource {
  return (SUPPORTED_SOURCES as readonly string[]).includes(value);
}

type ConnectorFactory = (
  source: SupportedConnectorSource,
  baseUrl: string | null | undefined,
  settings: SourceSettings
) => ProductConnector;

/**
 * One factory per protocol that has a connector today. A runnable protocol without an entry
 * (see `isRunnableProtocol` in lib/connectors/registry.ts) is not queueable yet.
 */
const CONNECTOR_FACTORIES: Partial<Record<ConnectorProtocol, ConnectorFactory>> = {
  OpenBeautyFacts: (_source, baseUrl) => new OpenBeautyFactsConnector(baseUrl),
  MakeupAPI: (_source, baseUrl) => new MakeupApiConnector(baseUrl),
  HoloTaco: (_source, baseUrl, settings) => new HoloTacoShopifyConnector(baseUrl, { currency: settings.currency }),
  Shopify: (source, baseUrl, settings) =>
    new ShopifyGenericConnector(source, baseUrl, { currency: settings.currency, settings }),
  // The feed URL is data_source.base_url unless metadata.feedUrl overrides it.
  ProductFeed: (source, baseUrl, settings) => {
    const feedUrl = settings.feedUrl ?? baseUrl?.trim();
    if (!feedUrl) {
      throw new Error(`${source}: no feed URL (set data_source.base_url or metadata.feedUrl)`);
    }
    assertAuthedFeedUsesHttps(source, feedUrl, settings);
    return new ProductFeedConnector(source, feedUrl, settings);
  },
  // metadata.sitemapUrl + metadata.productUrlPrefixes; the crawl is checkpointed in the job's
  // catalog cache, which must be durable (CONNECTOR_RAW_CONTAINER).
  SitemapJsonLd: (source, baseUrl, settings) => {
    if (!settings.sitemapUrl || settings.productUrlPrefixes.length === 0) {
      throw new Error(`${source}: metadata.sitemapUrl and metadata.productUrlPrefixes are required`);
    }
    return new SitemapJsonLdConnector(source, baseUrl, settings, {
      sitemapUrl: settings.sitemapUrl,
      productUrlPrefixes: settings.productUrlPrefixes,
    });
  },
  // The Store API under data_source.base_url; robots.txt is checked before any product request.
  WooCommerce: (source, baseUrl, settings) => new WooCommerceStoreConnector(source, baseUrl, settings),
  // The v0 API at api.bigcartel.com/{metadata.subdomain}. A Big Cartel product names no maker, so
  // metadata.brand is required: a record is never given another brand (no Holo Taco fallback).
  BigCartel: (source, baseUrl, settings) => {
    if (!settings.brand) throw new Error(`BigCartel source ${source} has no metadata.brand`);
    return new BigCartelConnector(source, baseUrl, settings);
  },
};

export function hasRunnableConnector(source: SupportedConnectorSource): boolean {
  return protocolOf(source) in CONNECTOR_FACTORIES;
}

/** A known source whose protocol has a connector factory (the worker can run it). */
export function isRunnableConnectorSource(value: string): value is SupportedConnectorSource {
  return isSupportedSource(value) && hasRunnableConnector(value);
}

/** The connector for a source (exported for tests); throws when its protocol has none or its settings are incomplete. */
export function createConnector(
  source: SupportedConnectorSource,
  baseUrl: string | null | undefined,
  settings: SourceSettings
): ProductConnector {
  return createConnectorForProtocol(protocolOf(source), source, baseUrl, settings);
}

/** `createConnector` for an explicit protocol (exported for tests of protocols no seeded source uses yet). */
export function createConnectorForProtocol(
  protocol: ConnectorProtocol,
  source: SupportedConnectorSource,
  baseUrl: string | null | undefined,
  settings: SourceSettings
): ProductConnector {
  const factory = CONNECTOR_FACTORIES[protocol];
  if (!factory) {
    throw new Error(`No connector available for source: ${source}`);
  }
  return factory(source, baseUrl, settings);
}
