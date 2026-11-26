/**
 * Sitemap + JSON-LD connector (`SitemapJsonLd` protocol: sources named `<Brand>Sitemap`).
 *
 * For a brand store with no products.json and no feed (OPI): read the store's sitemap
 * (`metadata.sitemapUrl`; a `<sitemapindex>` is followed one level), keep the `<loc>` values
 * that start with one of `metadata.productUrlPrefixes`, fetch each product page and read the
 * first schema.org `Product` from its `<script type="application/ld+json">` blocks.
 *
 * A catalog of ~570 pages at 1 s per request does not fit one worker invocation, so the crawl is
 * checkpointed through the job's catalog cache (`loadCheckpoint` / `saveCheckpoint`, a fenced
 * blob write) and needs a durable one. While the crawl is incomplete, a pull fetches at most
 * `SITEMAP_JSONLD_MAX_PAGES_PER_RUN` pages, never past `deadlineMs` minus
 * `SITEMAP_JSONLD_SAVE_MARGIN_MS`, saves the checkpoint and returns no records with
 * `metadata.catalogComplete: false`; the worker calls again with the same page number. Once the
 * crawl is complete, the stable catalog is gated, sorted (newest `lastmod` first) and windowed
 * by page like the Shopify connector, and every pull reports the complete `catalog` for listing
 * freshness.
 *
 * Every crawling pull first reads `<sitemap origin>/robots.txt` (`lib/robots.ts`): a `Disallow`
 * covering a configured product prefix's path (or `/`) throws `SitemapJsonLd disallowed by
 * robots.txt`; a missing robots.txt (any 4xx) allows. The same body is then checked before
 * every request of the pull: a disallowed root sitemap throws the same error, a disallowed
 * product page is never fetched and left out of the catalog ids like a gone page
 * (`metadata.robotsDisallowedPages`, one log line per URL). Child sitemaps of a `<sitemapindex>`
 * on another origin, or disallowed, are skipped (`metadata.foreignSitemapsSkipped`). A pull that sees
 * `SITEMAP_JSONLD_MAX_CONSECUTIVE_FAILURES` product pages fail in a row saves its checkpoint and
 * fails (a store blocking us must not burn through the whole catalog). A 429 or 503 with
 * `Retry-After` waits that long when it fits before the save margin, else the page is deferred.
 *
 * Redirects are followed by hand (`redirect: "manual"`, at most `SITEMAP_JSONLD_MAX_REDIRECTS`
 * hops, each paced like any request), and every destination is checked before it is requested:
 * robots.txt, the sitemap and its children follow only redirects on the sitemap's origin that
 * robots.txt allows (anything else fails the pull). A product page's destination must be on the
 * sitemap's origin and under a configured product prefix, else the page ends as gone
 * (`metadata.redirectedOutOfScope`, one log line per URL); a destination robots.txt disallows
 * is handled like a disallowed page; one more hop than allowed is a failed attempt. The page's
 * content is stored under its original (sitemap) URL.
 */

import { XMLParser } from "fast-xml-parser";
import type { ProductCategory } from "swatchwatch-shared";
import { normalizeGtin } from "../barcodes.js";
import { classifyIngestedProduct } from "../product-category.js";
import { normalizeCurrencyCode, normalizePriceAmount } from "../product-price.js";
import { htmlToPlainText, normalizeDescriptors, PRODUCT_DESCRIPTION_MAX_CHARS } from "../product-text.js";
import { isPathDisallowed } from "../robots.js";
import type { SourceSettings } from "../source-settings.js";
import { isRetailerSetSegment, parseConnectorTitle, type RetailerTitle } from "./retailer-title.js";
import { resolveConnectorBrand } from "./shopify-generic.js";
import {
  ConnectorCatalogCache,
  ConnectorCheckpointSupersededError,
  ConnectorProductRecord,
  ConnectorPullLog,
  ConnectorPullOptions,
  ConnectorPullResult,
  ProductConnector,
  SupportedConnectorSource,
} from "./types.js";

/** Parses an integer environment value, clamped to [min, max], or returns the fallback when it is not a number. */
function parseIntEnv(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value || "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

// The same request settings (and defaults) as the Shopify connectors.
const REQUEST_TIMEOUT_MS = parseIntEnv(process.env.SHOPIFY_CONNECTOR_REQUEST_TIMEOUT_MS, 45000, 5000, 180000);
const MAX_REQUEST_RETRIES = parseIntEnv(process.env.SHOPIFY_CONNECTOR_MAX_RETRIES, 2, 0, 6);
const RETRY_BASE_DELAY_MS = parseIntEnv(process.env.SHOPIFY_CONNECTOR_RETRY_BASE_DELAY_MS, 1000, 100, 30000);
const USER_AGENT = "SwatchWatch/connector-ingestion (+https://github.com/mattmck/swatchwatch)";
/** The product token robots.txt groups name us by. */
const ROBOTS_AGENT_TOKEN = "SwatchWatch";

/** Product pages failing in a row (any status but 200/404/410) that stop the pull and fail the job. */
export const SITEMAP_JSONLD_MAX_CONSECUTIVE_FAILURES = 10;

/** Pulls in which one page may be tried and left unanswered before it is recorded as failed. */
export const SITEMAP_JSONLD_MAX_URL_ATTEMPTS = 3;

/** The least time a request is started with: below it the pull stops (or, on entry, throws). */
export const SITEMAP_JSONLD_MIN_REQUEST_MS = 5000;

/** `SITEMAP_JSONLD_MAX_PAGES_PER_RUN`: product pages fetched per pull (default 150, 10–300). */
export function resolveSitemapMaxPagesPerRun(): number {
  return parseIntEnv(process.env.SITEMAP_JSONLD_MAX_PAGES_PER_RUN, 150, 10, 300);
}

/** `SITEMAP_JSONLD_SAVE_MARGIN_MS`: time kept before the deadline to save and hand off (default 20000, 5000–120000). */
export function resolveSitemapSaveMarginMs(): number {
  return parseIntEnv(process.env.SITEMAP_JSONLD_SAVE_MARGIN_MS, 20000, 5000, 120000);
}

/**
 * Pause between two requests to the store: `SHOPIFY_CONNECTOR_PAGE_DELAY_MS` (default 1000),
 * never below 1 s (the connector politeness rule).
 */
export function resolveSitemapPageDelayMs(): number {
  return parseIntEnv(process.env.SHOPIFY_CONNECTOR_PAGE_DELAY_MS, 1000, 1000, 10000);
}

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; signal: AbortSignal; redirect?: "manual" }
) => Promise<{
  ok: boolean;
  status: number;
  statusText?: string;
  headers?: { get(name: string): string | null } | null;
  text(): Promise<string>;
}>;

/** A `Retry-After` value (delay seconds or an HTTP date) in ms from `nowMs`; null when absent or unreadable. */
export function parseRetryAfterMs(value: string | null | undefined, nowMs: number): number | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : null;
}

/** Returns the origin of a URL, or null when it cannot be parsed. */
function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** One JSON-LD `Product` object as stored in the checkpoint (the record's `raw`). */
export type JsonLdProduct = Record<string, unknown>;

/** The crawl state saved through `catalogCache.saveCheckpoint` after every crawling pull. */
export interface SitemapCrawlCheckpoint {
  discovery: {
    /** True once `sitemapUrl` itself was read. */
    rootRead: boolean;
    /** Child sitemaps a `<sitemapindex>` root listed, in order. */
    children: string[];
    /** Children already read (their matching URLs are in `urls`). */
    done: string[];
    /** Children the index listed on another origin than `sitemapUrl` (never read). */
    foreignSkipped: number;
  };
  /** Product page URLs matching a prefix, deduped, in sitemap order. */
  urls: Array<{ url: string; lastmod: string | null }>;
  /** Fetched pages: the page's JSON-LD Product, or null (gone, or no Product on it). */
  pages: Record<string, JsonLdProduct | null>;
  /** Pulls in which a page was tried and not answered (cleared once it is answered or fails). */
  attempts: Record<string, number>;
  /**
   * Pages given up on: tried in `SITEMAP_JSONLD_MAX_URL_ATTEMPTS` pulls, retries exhausted, or a
   * non-retryable status other than 404/410. Never in `pages`; they never block `complete`.
   */
  failed: string[];
  /** Pages that answered 404 or 410 (also in `pages` as null): left out of the catalog ids. */
  gone: string[];
  /**
   * Pages robots.txt disallows (never fetched; also in `pages` as null): left out of the catalog
   * ids like `gone`, counted in `metadata.robotsDisallowedPages`.
   */
  robotsDisallowed: string[];
  /**
   * Pages whose redirect left the sitemap's origin or the product prefixes (also in `gone`, and
   * in `pages` as null; the destination is never requested), counted in
   * `metadata.redirectedOutOfScope`.
   */
  redirectedOutOfScope: string[];
  complete: boolean;
  /** Incremented on every save (log line only). */
  generation: number;
}

/** Builds the checkpoint of a crawl that has not started: nothing discovered, fetched or failed yet. */
function emptyCheckpoint(): SitemapCrawlCheckpoint {
  return {
    discovery: { rootRead: false, children: [], done: [], foreignSkipped: 0 },
    urls: [],
    pages: {},
    attempts: {},
    failed: [],
    gone: [],
    robotsDisallowed: [],
    redirectedOutOfScope: [],
    complete: false,
    generation: 0,
  };
}

/** Type guard for a plain object (not null, not an array). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns the string entries of an array value, or an empty list when it is not an array. */
function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** A stored checkpoint value, or a fresh one when it is missing; malformed values throw. */
export function readCrawlCheckpoint(value: unknown): SitemapCrawlCheckpoint {
  if (value === null || value === undefined) return emptyCheckpoint();
  if (!isRecord(value) || !isRecord(value.discovery) || !Array.isArray(value.urls) || !isRecord(value.pages)) {
    throw new Error("SitemapJsonLd: the saved crawl checkpoint is malformed");
  }
  const discovery = value.discovery;
  return {
    discovery: {
      rootRead: discovery.rootRead === true,
      children: stringList(discovery.children),
      done: stringList(discovery.done),
      foreignSkipped: typeof discovery.foreignSkipped === "number" ? discovery.foreignSkipped : 0,
    },
    urls: value.urls.flatMap((entry) =>
      isRecord(entry) && typeof entry.url === "string"
        ? [{ url: entry.url, lastmod: typeof entry.lastmod === "string" ? entry.lastmod : null }]
        : []
    ),
    pages: value.pages as Record<string, JsonLdProduct | null>,
    attempts: isRecord(value.attempts)
      ? Object.fromEntries(
          Object.entries(value.attempts).filter((entry): entry is [string, number] => typeof entry[1] === "number")
        )
      : {},
    failed: stringList(value.failed),
    gone: stringList(value.gone),
    robotsDisallowed: stringList(value.robotsDisallowed),
    redirectedOutOfScope: stringList(value.redirectedOutOfScope),
    complete: value.complete === true,
    generation: typeof value.generation === "number" ? value.generation : 0,
  };
}

// ── Parsing ────────────────────────────────────────────────────────────────────

export interface ParsedSitemap {
  kind: "urlset" | "index";
  entries: Array<{ url: string; lastmod: string | null }>;
}

/** Reads the text of a parsed XML node, which is a string or an object carrying `#text`; null when empty. */
function xmlText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (isRecord(value)) return xmlText(value["#text"]);
  return null;
}

/** A sitemap document: a `<urlset>` (page URLs) or a `<sitemapindex>` (child sitemap URLs). */
export function parseSitemapXml(body: string): ParsedSitemap {
  const parser = new XMLParser({
    ignoreAttributes: true,
    removeNSPrefix: true,
    parseTagValue: false,
    trimValues: true,
    isArray: (_name, jpath) => jpath === "urlset.url" || jpath === "sitemapindex.sitemap",
  });
  const document = parser.parse(body) as Record<string, unknown>;
  /** Maps parsed sitemap elements to `{ url, lastmod }` entries, skipping elements without a `<loc>`. */
  const read = (elements: unknown) =>
    (Array.isArray(elements) ? elements : []).flatMap((element) => {
      if (!isRecord(element)) return [];
      const url = xmlText(element.loc);
      return url ? [{ url, lastmod: xmlText(element.lastmod) }] : [];
    });
  if (isRecord(document.sitemapindex)) return { kind: "index", entries: read(document.sitemapindex.sitemap) };
  if (isRecord(document.urlset)) return { kind: "urlset", entries: read(document.urlset.url) };
  throw new Error("Sitemap has neither a <urlset> nor a <sitemapindex> root");
}

const LD_JSON_SCRIPT_REGEX = /<script\b[^>]*\btype\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;

/** Type guard for a JSON-LD node whose `@type` is (or includes) `Product`. */
function isProductNode(value: unknown): value is JsonLdProduct {
  if (!isRecord(value)) return false;
  const type = value["@type"];
  return type === "Product" || (Array.isArray(type) && type.includes("Product"));
}

/** Finds the first JSON-LD `Product` node in a parsed block, searching arrays and `@graph` entries; null when there is none. */
function findProduct(value: unknown): JsonLdProduct | null {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findProduct(entry);
      if (found) return found;
    }
    return null;
  }
  if (isProductNode(value)) return value;
  if (isRecord(value) && Array.isArray(value["@graph"])) return findProduct(value["@graph"]);
  return null;
}

/** The first JSON-LD `Product` on a page (a top-level object, an array member or an `@graph` member). */
export function extractJsonLdProduct(html: string): JsonLdProduct | null {
  for (const match of html.matchAll(LD_JSON_SCRIPT_REGEX)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1].trim());
    } catch {
      continue; // A broken block (often a templating leftover) never hides a later one.
    }
    const product = findProduct(parsed);
    if (product) return product;
  }
  return null;
}

/**
 * JSON-LD `image` as URL strings: a string, an `ImageObject` (`url` or `contentUrl`), or an
 * array of either; deduped, order kept.
 */
export function jsonLdImageUrls(value: unknown): string[] {
  const urls: string[] = [];
  /** Collects the URL of a string or `{ url | contentUrl }` image entry into `urls`. */
  const add = (entry: unknown) => {
    if (typeof entry === "string") {
      if (entry.trim()) urls.push(entry.trim());
    } else if (isRecord(entry)) {
      add(typeof entry.url === "string" ? entry.url : entry.contentUrl);
    }
  };
  for (const entry of Array.isArray(value) ? value : [value]) add(entry);
  return [...new Set(urls)];
}

/** Normalizes a string (whitespace collapsed) or finite number to trimmed text; null for anything else or an empty result. */
function text(value: unknown): string | null {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim() || null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/** Picks the offer that carries a price, unwrapping an AggregateOffer's nested offers; null when none does. */
function firstOffer(product: JsonLdProduct): Record<string, unknown> | null {
  const offers = product.offers;
  const list = Array.isArray(offers) ? offers : [offers];
  for (const offer of list) {
    if (!isRecord(offer)) continue;
    // An AggregateOffer nests its offers; its own lowPrice stands in for a price.
    if (Array.isArray(offer.offers)) {
      const nested = offer.offers.find(isRecord);
      if (nested) return nested;
    }
    return offer;
  }
  return null;
}

/**
 * schema.org `availability` (a URL or a bare name): InStock, PreOrder, LimitedAvailability,
 * OnlineOnly, InStoreOnly → true; OutOfStock, SoldOut, BackOrder, Discontinued → false;
 * anything else or missing → null.
 */
export function parseJsonLdAvailability(value: unknown): boolean | null {
  const name = text(value)?.replace(/^https?:\/\/schema\.org\//i, "").toLowerCase();
  if (!name) return null;
  if (["instock", "preorder", "presale", "limitedavailability", "onlineonly", "instoreonly"].includes(name)) return true;
  if (["outofstock", "soldout", "backorder", "discontinued"].includes(name)) return false;
  return null;
}

/** Reads the brand name from a Product's `brand` (a string, a list, or a `{ name }` object); null when absent. */
function brandOf(product: JsonLdProduct): string | null {
  const brand = product.brand;
  if (typeof brand === "string") return text(brand);
  if (Array.isArray(brand)) return brand.map((entry) => (isRecord(entry) ? text(entry.name) : text(entry))).find(Boolean) ?? null;
  return isRecord(brand) ? text(brand.name) : null;
}

/** Returns the path of a URL, or the input itself when it is not an absolute URL. */
function urlPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** "https://www.opi.com/products/nail-lacquer-" → "Nail Lacquer" (the product line a prefix names). */
function lineFromPrefix(prefix: string): string | null {
  const slug = urlPath(prefix).split("/").filter(Boolean).pop()?.replace(/-+$/, "");
  if (!slug) return null;
  return slug
    .split("-")
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

// ── Gate and records ─────────────────────────────────────────────────────────

interface GatedPage {
  url: string;
  lastmod: string | null;
  product: JsonLdProduct;
  title: string;
  brand: string;
  category: ProductCategory;
  shadeName: string;
  productLine: string | null;
  listing: RetailerTitle | null;
}

type GateOutcome = { accept: true; gated: GatedPage } | { accept: false; vendorless?: true };

/**
 * Whether a crawled page is ingested: a Product with a name and a brand (`resolveConnectorBrand`:
 * the `vendorAliases` entry for `brand.name`, else `brand.name`, else `settings.brand`; none =
 * skipped, counted as vendorless); the shared connector gate over
 * the name and the product line (a prefix match is the polish signal); no set (gate evidence `set`; a `feed`/`retailer` source also
 * drops a title ending in a set word or one `parseRetailerTitle` reads as a set).
 */
export function gateCrawledPage(
  page: { url: string; lastmod: string | null; product: JsonLdProduct },
  settings: SourceSettings,
  prefixes: readonly string[]
): GateOutcome {
  const title = text(page.product.name);
  if (!title) return { accept: false };
  const brand = resolveConnectorBrand(brandOf(page.product), settings);
  if (!brand) return { accept: false, vendorless: true };

  // Enterprise titles may carry the line ("OPI Nail Lacquer - Big Apple Red"): the parser strips
  // the brand and line in brand mode too, when the title starts with the brand or a line word
  // (`parseBrandStoreTitle`). Without one, the matching URL prefix names the line.
  const listing = parseConnectorTitle(title, brand, settings.kind, brandOf(page.product));
  const prefix = prefixes.find((candidate) => page.url.startsWith(candidate));
  const productLine = listing?.productLine ?? (prefix ? lineFromPrefix(prefix) : null);
  // Every crawled URL matched a configured product prefix, and the prefixes name polish lines
  // ("nail-lacquer-", "infinite-shine-"): that is the gate's polish signal ("Infinite Shine" has
  // no polish word). Accessory, set and coat rules still read the title and the line.
  const gate = classifyIngestedProduct({ title, productType: productLine, tags: ["nail polish"] });
  if (!gate.accept || gate.evidence === "set") return { accept: false };
  if (settings.kind !== "brand" && (isRetailerSetSegment(title) || !listing || listing.isSet)) {
    return { accept: false };
  }
  return {
    accept: true,
    gated: {
      ...page,
      title,
      brand,
      category: gate.category,
      shadeName: listing?.shadeName ?? title,
      productLine,
      listing,
    },
  };
}

export interface CrawledRecordResult {
  record: ConnectorProductRecord;
  invalidCheckDigit: string | null;
}

/** The connector record for a page `gateCrawledPage` accepted. */
export function buildCrawledRecord(gated: GatedPage, settings: SourceSettings): CrawledRecordResult {
  const { product, url, title, brand, category, shadeName, productLine, listing } = gated;
  const externalId = urlPath(url);
  const gtinRaw = product.gtin ?? product.gtin13 ?? product.gtin12 ?? product.gtin14;
  const gtin = normalizeGtin(typeof gtinRaw === "number" ? String(gtinRaw) : gtinRaw);
  const imageUrls = jsonLdImageUrls(product.image);
  const offer = firstOffer(product);
  const price = normalizePriceAmount(offer?.price ?? offer?.lowPrice ?? null);
  const currency = normalizeCurrencyCode(offer?.priceCurrency);
  return {
    invalidCheckDigit: gtin && !gtin.checkDigitValid ? gtin.gtin : null,
    record: {
      externalId,
      gtin: gtin?.gtin ?? null,
      raw: product,
      normalized: {
        productId: externalId,
        brand,
        name: shadeName,
        rawTitle: title,
        productLine,
        // Only a "#CODE" parsed from the title becomes `vendorCode` (and so a shade alias); the
        // page's SKU is the store's stock code and stays in `sku`.
        vendorCode: listing?.vendorCode ?? null,
        sku: text(product.sku),
        productType: productLine,
        // Connector-gate category (#349); materialization re-classifies with the shade's finishes.
        productCategory: category,
        tags: [],
        finishes: [],
        collections: [],
        descriptors: normalizeDescriptors([productLine]),
        descriptionText: htmlToPlainText(text(product.description), PRODUCT_DESCRIPTION_MAX_CHARS),
        imageUrls,
        primaryImageUrl: imageUrls[0] ?? null,
        // The crawled URL: it matched a configured prefix on the sitemap's origin; the JSON-LD
        // `url` is page content and is not trusted as a link.
        productUrl: url,
        price: price && currency ? price : null,
        currency: price && currency ? currency : null,
        available: parseJsonLdAvailability(offer?.availability),
        kind: settings.kind,
        ...(settings.kind !== "brand" ? { listingTitle: title } : {}),
      },
    },
  };
}

const SEARCH_TERMS_MEANING_ALL = new Set(["", "nail polish", "nail_polish", "nailpolish", "all", "*", "recent", "latest", "new"]);
const DEFAULT_RECENT_DAYS = 120;

/** Resolves the recent-pages window in days from an explicit value or the `recent`/`latest`/`new` search terms; null means no window. */
function resolveRecentDays(searchTerm: string, recentDays?: number): number | null {
  if (typeof recentDays === "number" && Number.isFinite(recentDays) && recentDays > 0) return recentDays;
  return ["recent", "latest", "new"].includes(searchTerm.trim().toLowerCase()) ? DEFAULT_RECENT_DAYS : null;
}

/** Converts a sitemap `lastmod` string to epoch milliseconds, or 0 when it is missing or unparseable. */
function lastmodEpoch(value: string | null): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

// ── Connector ────────────────────────────────────────────────────────────────

export interface SitemapJsonLdConnectorOptions {
  sitemapUrl: string;
  productUrlPrefixes: readonly string[];
  /** Injected in tests; defaults to the global fetch. */
  fetchImpl?: FetchLike;
  /** Injected in tests (a fake clock); default `Date.now` and `setTimeout`. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Override the env-derived limits (tests). */
  maxPagesPerRun?: number;
  saveMarginMs?: number;
  pageDelayMs?: number;
}

type RequestOutcome =
  | { status: "ok"; body: string }
  /** A non-retryable HTTP status (404, 410, 403 ...). */
  | { status: "http"; httpStatus: number }
  /** Every attempt failed with a retryable error (5xx, 429, timeout, network). */
  | { status: "exhausted"; reason: string }
  /**
   * A product page's fetch or body read threw a non-retryable error (`TypeError: terminated`,
   * an invalid URL): one attempt for that page, given up on at once when `permanent`.
   */
  | { status: "error"; reason: string; permanent: boolean }
  /**
   * Not attempted (`attempted: false`) or not retried (`attempted: true`, with the last failure)
   * because it would not fit before the save margin.
   */
  | { status: "deferred"; attempted: boolean; reason?: string }
  /** A 3xx with a `Location` (resolved against the request URL); never followed by `request`. */
  | { status: "redirect"; httpStatus: number; location: string };

/** Why a redirect destination is not requested. */
type RedirectRefusal = "out_of_scope" | "robots";

/** `request` after `requestFollowingRedirects`: a redirect is followed, refused or one hop too many. */
type FollowedOutcome =
  | Exclude<RequestOutcome, { status: "redirect" }>
  | { status: "redirect_refused"; refusal: RedirectRefusal; destination: string }
  | { status: "too_many_redirects"; destination: string };

/** Redirect hops followed per request; one more redirect is a failure. */
export const SITEMAP_JSONLD_MAX_REDIRECTS = 3;

/** A page the crawl gave up on in this pull (logged through the pull's `log` when recorded). */
export interface FailedPage {
  url: string;
  reason: string;
}

/** A request error no later attempt can fix (a malformed URL, an unsupported scheme). */
function isPermanentRequestError(error: Error): boolean {
  if ((error as { code?: unknown }).code === "ERR_INVALID_URL") return true;
  return /invalid url|failed to parse url|unsupported protocol|unknown scheme/i.test(error.message);
}

/** True for HTTP statuses worth retrying (timeouts, rate limits, 5xx). */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/** True for request errors worth retrying (aborts, timeouts and transient network failures). */
function isRetryableRequestError(error: Error): boolean {
  if (error.name === "AbortError") return true;
  const message = error.message.toLowerCase();
  return ["timed out", "fetch failed", "econnreset", "econnrefused", "etimedout", "enotfound", "eai_again"].some(
    (needle) => message.includes(needle)
  );
}

export class SitemapJsonLdConnector implements ProductConnector {
  readonly source: SupportedConnectorSource;
  private readonly baseUrl: string | null;
  private readonly settings: SourceSettings;
  private readonly sitemapUrl: string;
  private readonly prefixes: readonly string[];
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxPagesPerRun: number;
  private readonly saveMarginMs: number;
  private readonly pageDelayMs: number;
  /** Start of the last request to the store, across the pulls of this invocation (pacing). */
  private lastRequestAt: number | null = null;

  constructor(
    source: SupportedConnectorSource,
    baseUrl: string | null | undefined,
    settings: SourceSettings,
    options: SitemapJsonLdConnectorOptions
  ) {
    if (!options.sitemapUrl) throw new Error(`${source}: metadata.sitemapUrl is required`);
    if (options.productUrlPrefixes.length === 0) throw new Error(`${source}: metadata.productUrlPrefixes is required`);
    this.source = source;
    this.baseUrl = baseUrl?.trim() || null;
    this.settings = settings;
    this.sitemapUrl = options.sitemapUrl;
    this.prefixes = options.productUrlPrefixes;
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxPagesPerRun = options.maxPagesPerRun ?? resolveSitemapMaxPagesPerRun();
    this.saveMarginMs = options.saveMarginMs ?? resolveSitemapSaveMarginMs();
    this.pageDelayMs = options.pageDelayMs ?? resolveSitemapPageDelayMs();
  }

  /**
   * Worst-case length of one crawling pull: its page budget of pacing plus one request timeout,
   * and never less than the save margin plus one request (below that `pullProducts` throws
   * "worker budget too small", so the worker must hand off instead).
   */
  crawlPullEstimateMs(): number {
    return Math.max(
      this.maxPagesPerRun * this.pageDelayMs + REQUEST_TIMEOUT_MS,
      this.saveMarginMs + SITEMAP_JSONLD_MIN_REQUEST_MS
    );
  }

  async pullProducts(options: ConnectorPullOptions): Promise<ConnectorPullResult> {
    const cache = options.catalogCache;
    if (!cache?.loadCheckpoint || !cache.saveCheckpoint) {
      throw new Error("SitemapJsonLd needs a durable catalog cache (CONNECTOR_RAW_CONTAINER)");
    }
    const loaded = await cache.loadCheckpoint();
    if (cache.durable !== true) {
      throw new Error("SitemapJsonLd needs a durable catalog cache (CONNECTOR_RAW_CONTAINER)");
    }
    const state = readCrawlCheckpoint(loaded?.value ?? null);
    let pagesThisPull = 0;
    let requestsThisPull = 0;
    const failedThisPull: FailedPage[] = [];

    if (!state.complete) {
      if (typeof options.deadlineMs !== "number" || !Number.isFinite(options.deadlineMs)) {
        throw new Error("SitemapJsonLd needs deadlineMs (the worker's invocation deadline)");
      }
      const stopAt = options.deadlineMs - this.saveMarginMs;
      if (stopAt - this.now() < SITEMAP_JSONLD_MIN_REQUEST_MS) {
        throw new Error("SitemapJsonLd: worker budget too small to fetch a page");
      }
      let crawl: CrawlResult;
      try {
        crawl = await this.crawl(state, stopAt, failedThisPull, options.log);
      } catch (error) {
        // Keep what this pull already fetched (the crawl updates `state` in place); the
        // original error still fails the job. A superseded save wins over it: the newer
        // invocation owns the job.
        state.generation += 1;
        try {
          await this.save(cache, state, loaded?.etag ?? null);
        } catch (saveError) {
          if (saveError instanceof ConnectorCheckpointSupersededError) throw saveError;
        }
        throw error;
      }
      pagesThisPull = crawl.pages;
      requestsThisPull = crawl.requests;
      state.generation += 1;
      await this.save(cache, state, loaded?.etag ?? null);
    }

    const totalPages = state.urls.length;
    const failed = new Set(state.failed);
    const crawledPages = state.urls.filter(({ url }) => url in state.pages || failed.has(url)).length;
    const crawlMetadata = {
      requestUrl: this.sitemapUrl,
      storeBaseUrl: this.baseUrl,
      connectorType: "sitemap-jsonld",
      sourceKind: this.settings.kind,
      catalogComplete: state.complete,
      crawledPages,
      totalPages,
      failedPages: state.failed.length,
      // Pages given up on in this pull (each already logged through `options.log`).
      failedThisPull,
      pagesThisPull,
      requestsThisPull,
      checkpointGeneration: state.generation,
      crawlPullEstimateMs: this.crawlPullEstimateMs(),
      sitemapChildren: state.discovery.children.length,
      sitemapChildrenRead: state.discovery.done.length,
      foreignSitemapsSkipped: state.discovery.foreignSkipped,
      robotsDisallowedPages: state.robotsDisallowed.length,
      redirectedOutOfScope: state.redirectedOutOfScope.length,
    };

    if (!state.complete) {
      return {
        source: this.source,
        records: [],
        metadata: { ...crawlMetadata, responsePage: options.page, responsePageSize: options.pageSize },
      };
    }

    const gated: GatedPage[] = [];
    let vendorlessSkipped = 0;
    let pagesWithoutProduct = 0;
    const disallowed = new Set(state.robotsDisallowed);
    for (const { url, lastmod } of state.urls) {
      if (failed.has(url) || disallowed.has(url)) continue;
      const product = state.pages[url];
      if (!product) {
        pagesWithoutProduct += 1;
        continue;
      }
      const outcome = gateCrawledPage({ url, lastmod, product }, this.settings, this.prefixes);
      if (outcome.accept) gated.push(outcome.gated);
      else if (outcome.vendorless) vendorlessSkipped += 1;
    }

    const term = options.searchTerm.trim().toLowerCase();
    const textFilter = SEARCH_TERMS_MEANING_ALL.has(term) ? null : term;
    const recentDays = resolveRecentDays(options.searchTerm, options.recentDays);
    const cutoff = recentDays ? this.now() - recentDays * 24 * 60 * 60 * 1000 : null;
    const filtered = gated
      .filter(
        (entry) =>
          !textFilter ||
          [entry.title, entry.brand, entry.productLine, entry.url].some((value) => value?.toLowerCase().includes(textFilter))
      )
      .filter((entry) => cutoff === null || lastmodEpoch(entry.lastmod) >= cutoff)
      // Array#sort is stable: equal lastmods keep sitemap order across calls.
      .sort((a, b) => lastmodEpoch(b.lastmod) - lastmodEpoch(a.lastmod));

    const offset = Math.max(0, (options.page - 1) * options.pageSize);
    const windowed = filtered.slice(offset, offset + options.pageSize).slice(0, options.maxRecords);
    const built = windowed.map((entry) => buildCrawledRecord(entry, this.settings));
    // A failed (flaky) page keeps its listing; a page that answered 404/410 is left out so a
    // delisted product lingering in a lagging sitemap gets missing_since.
    // A page robots.txt disallows is left out too (never fetched, so never confirmed).
    const gone = new Set([...state.gone, ...state.robotsDisallowed]);
    const externalIds = [...new Set(state.urls.filter(({ url }) => !gone.has(url)).map(({ url }) => urlPath(url)))];

    return {
      source: this.source,
      records: built.map((entry) => entry.record),
      // Every page URL the sitemap listed (before the gate and the window), on every pull of a
      // complete crawl; the worker runs listing freshness once per job.
      // A robots exclusion (a disallowed page or a skipped child sitemap) leaves listings that
      // were never confirmed either way, so the catalog is reported incomplete and the worker
      // skips listing freshness rather than marking them missing.
      catalog: {
        externalIds,
        complete: externalIds.length > 0 && state.robotsDisallowed.length === 0 && state.discovery.foreignSkipped === 0,
      },
      metadata: {
        ...crawlMetadata,
        responsePage: options.page,
        responsePageSize: options.pageSize,
        sourceCount: filtered.length,
        sourcePageCount: options.pageSize > 0 ? Math.ceil(filtered.length / options.pageSize) : null,
        fetchedProductCount: totalPages - pagesWithoutProduct - state.failed.length - disallowed.size,
        pagesWithoutProduct,
        recentDays,
        textFilter,
        vendorlessSkipped,
        invalidCheckDigits: built
          .filter((entry) => entry.invalidCheckDigit !== null)
          .map((entry) => ({ externalId: entry.record.externalId, gtin: entry.invalidCheckDigit as string })),
      },
    };
  }

  private async save(cache: ConnectorCatalogCache, state: SitemapCrawlCheckpoint, etag: string | null): Promise<void> {
    try {
      await cache.saveCheckpoint!(state, etag);
    } catch (error) {
      if (error instanceof ConnectorCheckpointSupersededError) {
        throw new ConnectorCheckpointSupersededError("SitemapJsonLd checkpoint superseded");
      }
      throw error;
    }
  }

  /** Discovery, then product pages, until done, the page budget is spent or `stopAt` is near. */
  private async crawl(
    state: SitemapCrawlCheckpoint,
    stopAt: number,
    failedThisPull: FailedPage[],
    log: ConnectorPullLog | undefined
  ): Promise<CrawlResult> {
    let requests = 0;
    const known = new Set(state.urls.map(({ url }) => url));
    /** Adds sitemap entries under a configured product prefix to the crawl's URL list, skipping ones already known. */
    const addUrls = (entries: ParsedSitemap["entries"]) => {
      for (const entry of entries) {
        if (known.has(entry.url) || !this.prefixes.some((prefix) => entry.url.startsWith(prefix))) continue;
        known.add(entry.url);
        state.urls.push(entry);
      }
    };

    // robots.txt once per crawling pull, before discovery and any product page.
    const sitemapOrigin = originOf(this.sitemapUrl);
    if (!sitemapOrigin) throw new Error(`${this.source}: metadata.sitemapUrl is not an absolute URL`);
    /** Refuses a redirect destination outside the sitemap's origin. */
    const sameOrigin = (destination: string): RedirectRefusal | null =>
      originOf(destination) === sitemapOrigin ? null : "out_of_scope";
    const robots = await this.requestFollowingRedirects(`${sitemapOrigin}/robots.txt`, stopAt, "robots", sameOrigin);
    requests += robots.requests;
    if (robots.status === "deferred") return { pages: 0, requests };
    // The body is kept for this pull: every sitemap and product page URL is checked against it
    // before it is requested. Null (a missing robots.txt) allows everything.
    let robotsBody: string | null = null;
    if (robots.status === "ok") {
      robotsBody = robots.body;
      const paths = this.prefixes.map(urlPath);
      if (paths.some((prefixPath) => isPathDisallowed(robots.body, ROBOTS_AGENT_TOKEN, prefixPath))) {
        throw new Error("SitemapJsonLd disallowed by robots.txt");
      }
    } else if (!(robots.status === "http" && robots.httpStatus >= 400 && robots.httpStatus < 500)) {
      // A missing robots.txt (any 4xx) allows everything (RFC 9309); a 5xx or network failure fails.
      throw new Error(`${this.source} robots.txt request failed: ${describeOutcome(robots)}`);
    }
    /** True when robots.txt (if one was read) allows the URL for this crawler. */
    const allowed = (url: string) =>
      robotsBody === null || !isPathDisallowed(robotsBody, ROBOTS_AGENT_TOKEN, urlPath(url));
    // A sitemap or child sitemap follows only same-origin redirects robots.txt allows.
    /** Redirect check for sitemap documents: same origin and allowed by robots.txt. */
    const sitemapRedirect = (destination: string): RedirectRefusal | null =>
      sameOrigin(destination) ?? (allowed(destination) ? null : "robots");
    // A product page's destination must also stay under a configured product prefix.
    /** Redirect check for product pages: same origin, under a configured product prefix and allowed by robots.txt. */
    const pageRedirect = (destination: string): RedirectRefusal | null =>
      sameOrigin(destination) ??
      (this.prefixes.some((prefix) => destination.startsWith(prefix)) ? null : "out_of_scope") ??
      (allowed(destination) ? null : "robots");
    /** Logs a warning to the job log when one is attached, else to the console. */
    const warn = (message: string, data: Record<string, unknown>) => {
      if (log) log("warn", message, data);
      else console.warn(`${this.source} ${message}`);
    };

    if (!state.discovery.rootRead) {
      if (!allowed(this.sitemapUrl)) throw new Error("SitemapJsonLd disallowed by robots.txt");
      const outcome = await this.requestFollowingRedirects(this.sitemapUrl, stopAt, "sitemap", sitemapRedirect);
      requests += outcome.requests;
      if (outcome.status === "deferred") return { pages: 0, requests };
      if (outcome.status !== "ok") throw new Error(`${this.source} sitemap request failed: ${describeOutcome(outcome)}`);
      const root = parseSitemapXml(outcome.body);
      if (root.kind === "index") {
        // Only child sitemaps on the sitemap's own origin that robots.txt allows are read.
        const children = [...new Set(root.entries.map((entry) => entry.url))];
        const readable = children.filter((child) => originOf(child) === sitemapOrigin && allowed(child));
        state.discovery.children = readable;
        state.discovery.foreignSkipped = children.length - readable.length;
        if (state.discovery.foreignSkipped > 0) {
          warn(
            `Skipped ${state.discovery.foreignSkipped} child sitemap(s) on another origin than ${sitemapOrigin} or disallowed by robots.txt`,
            { foreignSitemapsSkipped: state.discovery.foreignSkipped }
          );
        }
      } else {
        addUrls(root.entries);
      }
      state.discovery.rootRead = true;
    }
    for (const child of state.discovery.children) {
      if (state.discovery.done.includes(child)) continue;
      if (!allowed(child)) {
        // Listed by an earlier pull, disallowed by this pull's robots.txt: skipped like a foreign one.
        state.discovery.done.push(child);
        state.discovery.foreignSkipped += 1;
        warn(`Skipped a child sitemap disallowed by robots.txt: ${child}`, { url: child });
        continue;
      }
      const outcome = await this.requestFollowingRedirects(child, stopAt, "sitemap", sitemapRedirect);
      requests += outcome.requests;
      if (outcome.status === "deferred") return { pages: 0, requests };
      if (outcome.status !== "ok") throw new Error(`${this.source} child sitemap request failed: ${describeOutcome(outcome)}`);
      const parsed = parseSitemapXml(outcome.body);
      // One level only: a nested index's children are not followed.
      if (parsed.kind === "urlset") addUrls(parsed.entries);
      state.discovery.done.push(child);
    }

    let pages = 0;
    const failed = new Set(state.failed);
    /** Records a page as permanently failed for this crawl and logs why. */
    const giveUp = (url: string, reason: string) => {
      failed.add(url);
      state.failed.push(url);
      delete state.attempts[url];
      failedThisPull.push({ url, reason });
      // Logged when it is recorded, so the line survives a pull that throws later or a worker
      // that loses the job before it reads `failedThisPull`.
      const message = `Crawl gave up on a page: ${url} (${reason})`;
      if (log) log("warn", message, { url, reason });
      else console.warn(`${this.source} ${message}`);
    };
    /** Counts one unanswered pull for a page and gives it up once the attempt limit is reached. */
    const countAttempt = (url: string, reason: string) => {
      const attempts = (state.attempts[url] ?? 0) + 1;
      state.attempts[url] = attempts;
      if (attempts >= SITEMAP_JSONLD_MAX_URL_ATTEMPTS) giveUp(url, `not answered in ${attempts} pulls (last: ${reason})`);
    };
    // A page that errored in this pull stays for the next pull, so the crawl is not complete yet.
    let pendingRetry = false;
    // Product pages failing in a row; any answered page (200, 404, 410) resets it.
    let consecutiveFailures = 0;
    /** Counts a failed page request and aborts the pull after too many consecutive failures. */
    const pageFailed = (status: string) => {
      consecutiveFailures += 1;
      if (consecutiveFailures >= SITEMAP_JSONLD_MAX_CONSECUTIVE_FAILURES) {
        throw new Error(`SitemapJsonLd: ${consecutiveFailures} consecutive page failures (status ${status}), stopping`);
      }
    };
    for (const { url } of state.urls) {
      if (url in state.pages || failed.has(url)) continue;
      if (!allowed(url)) {
        // Never requested; recorded like a gone page (left out of the catalog ids), logged once.
        state.robotsDisallowed.push(url);
        state.pages[url] = null;
        delete state.attempts[url];
        warn(`Skipped a page disallowed by robots.txt: ${url}`, { url });
        continue;
      }
      if (pages >= this.maxPagesPerRun) return { pages, requests };
      const outcome = await this.requestFollowingRedirects(url, stopAt, "page", pageRedirect);
      requests += outcome.requests;
      if (outcome.status === "deferred") {
        // Out of time. A page tried in this pull counts one attempt; after
        // SITEMAP_JSONLD_MAX_URL_ATTEMPTS pulls it is given up on, so a dead page never stalls the crawl.
        if (outcome.attempted) countAttempt(url, outcome.reason ?? "unknown");
        return { pages, requests };
      }
      pages += 1;
      if (outcome.status === "redirect_refused") {
        // The destination is never requested; the page answered, so it is settled for this crawl.
        state.pages[url] = null;
        delete state.attempts[url];
        consecutiveFailures = 0;
        if (outcome.refusal === "robots") {
          state.robotsDisallowed.push(url);
          warn(`Skipped a page whose redirect robots.txt disallows: ${url}`, { url, destination: outcome.destination });
        } else {
          state.gone.push(url);
          state.redirectedOutOfScope.push(url);
          warn(`A page redirected out of scope, treated as gone: ${url}`, { url, destination: outcome.destination });
        }
        continue;
      }
      if (outcome.status === "too_many_redirects") {
        const reason = `more than ${SITEMAP_JSONLD_MAX_REDIRECTS} redirects`;
        countAttempt(url, reason);
        if (!failed.has(url)) pendingRetry = true;
        pageFailed(reason);
        continue;
      }
      if (outcome.status === "error") {
        // One attempt for this page in this pull; the crawl moves on to the next page.
        if (outcome.permanent) {
          giveUp(url, outcome.reason);
        } else {
          countAttempt(url, outcome.reason);
          if (!failed.has(url)) pendingRetry = true;
        }
        pageFailed(outcome.reason);
        continue;
      }
      if (outcome.status === "exhausted") {
        giveUp(url, outcome.reason);
        pageFailed(outcome.reason.replace(/^HTTP /, ""));
        continue;
      }
      if (outcome.status === "http") {
        if (outcome.httpStatus !== 404 && outcome.httpStatus !== 410) {
          giveUp(url, `HTTP ${outcome.httpStatus}`);
          pageFailed(String(outcome.httpStatus));
          continue;
        }
        state.gone.push(url);
        state.pages[url] = null;
      } else {
        state.pages[url] = extractJsonLdProduct(outcome.body);
      }
      consecutiveFailures = 0;
      delete state.attempts[url];
    }
    if (!pendingRetry) state.complete = true;
    return { pages, requests };
  }

  /**
   * `request`, following up to `SITEMAP_JSONLD_MAX_REDIRECTS` redirects by hand. Every
   * destination goes through `admit` before it is requested (a refusal is returned, never
   * fetched); each hop is its own paced request. `requests` counts the GETs made.
   */
  private async requestFollowingRedirects(
    url: string,
    stopAt: number,
    kind: "robots" | "sitemap" | "page",
    admit: (destination: string) => RedirectRefusal | null
  ): Promise<FollowedOutcome & { requests: number }> {
    let current = url;
    for (let hops = 0; ; hops += 1) {
      const outcome = await this.request(current, stopAt, kind);
      const requests = hops + 1;
      if (outcome.status === "deferred") {
        // A redirect already answered in this pull counts as an attempt of the page.
        return { ...outcome, attempted: outcome.attempted || hops > 0, requests };
      }
      if (outcome.status !== "redirect") return { ...outcome, requests };
      let destination: string;
      try {
        destination = new URL(outcome.location, current).toString();
      } catch {
        const reason = `HTTP ${outcome.httpStatus} with an unreadable Location`;
        if (kind !== "page") throw new Error(`${this.source} ${kind} request failed: ${reason}`);
        return { status: "error", reason, permanent: true, requests };
      }
      if (hops >= SITEMAP_JSONLD_MAX_REDIRECTS) return { status: "too_many_redirects", destination, requests };
      const refusal = admit(destination);
      if (refusal) return { status: "redirect_refused", refusal, destination, requests };
      current = destination;
    }
  }

  /**
   * One GET, paced and bounded by `stopAt`: every attempt (and its wait) starts only with at
   * least `SITEMAP_JSONLD_MIN_REQUEST_MS` left and times out by `stopAt`; a retry that would not
   * fit is not made (`deferred`). Retryable failures on every attempt are `exhausted`. A
   * non-retryable thrown error (not a timeout or network error) is fatal and thrown for a
   * sitemap request; for a product page it is returned as `error` (one attempt for that page).
   */
  private async request(url: string, stopAt: number, kind: "robots" | "sitemap" | "page"): Promise<RequestOutcome> {
    const attemptCount = MAX_REQUEST_RETRIES + 1;
    let backoffMs = 0;
    let lastFailure: string | undefined;
    for (let attempt = 1; attempt <= attemptCount; attempt += 1) {
      const paceMs = this.lastRequestAt === null ? 0 : Math.max(0, this.lastRequestAt + this.pageDelayMs - this.now());
      const waitMs = Math.max(paceMs, backoffMs);
      const remainingAfterWait = stopAt - this.now() - waitMs;
      if (remainingAfterWait < SITEMAP_JSONLD_MIN_REQUEST_MS) {
        return { status: "deferred", attempted: attempt > 1, reason: lastFailure };
      }
      if (waitMs > 0) await this.sleep(waitMs);

      const timeoutMs = Math.min(REQUEST_TIMEOUT_MS, stopAt - this.now());
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      this.lastRequestAt = this.now();
      let retryReason: string;
      let retryAfterMs: number | null = null;
      try {
        const response = await this.fetchImpl(url, {
          method: "GET",
          headers: {
            Accept:
              kind === "robots"
                ? "text/plain, */*;q=0.5"
                : kind === "sitemap"
                  ? "application/xml, text/xml;q=0.9, */*;q=0.5"
                  : "text/html, application/xhtml+xml;q=0.9, */*;q=0.5",
            "User-Agent": USER_AGENT,
          },
          signal: controller.signal,
          redirect: "manual",
        });
        if (response.ok) return { status: "ok", body: await response.text() };
        const location = response.status >= 300 && response.status < 400 ? response.headers?.get("location") : null;
        if (location) return { status: "redirect", httpStatus: response.status, location };
        if (!isRetryableStatus(response.status)) return { status: "http", httpStatus: response.status };
        retryReason = `HTTP ${response.status}`;
        retryAfterMs = parseRetryAfterMs(response.headers?.get("retry-after"), this.now());
      } catch (error) {
        let normalized = error instanceof Error ? error : new Error(String(error));
        if (normalized.name === "AbortError") {
          normalized = new Error(`${this.source} ${kind} request timed out after ${timeoutMs}ms`);
        }
        if (!isRetryableRequestError(normalized)) {
          if (kind !== "page") throw normalized;
          const reason = `${normalized.name === "Error" ? "" : `${normalized.name}: `}${normalized.message}`;
          return { status: "error", reason, permanent: isPermanentRequestError(normalized) };
        }
        retryReason = normalized.message;
      } finally {
        clearTimeout(timeout);
      }
      lastFailure = retryReason;
      if (attempt >= attemptCount) return { status: "exhausted", reason: retryReason };
      // A Retry-After longer than the linear backoff is honoured; one that does not fit before
      // the save margin defers the page (the check at the top of the next attempt).
      backoffMs = Math.max(RETRY_BASE_DELAY_MS * attempt, retryAfterMs ?? 0);
      console.warn(`${this.source} ${kind} retry ${attempt}/${MAX_REQUEST_RETRIES} after ${retryReason}; waiting ${backoffMs}ms`, { url });
    }
    return { status: "exhausted", reason: lastFailure ?? "request failed" };
  }
}

interface CrawlResult {
  pages: number;
  requests: number;
}

/** Describes a failed request outcome for the job log without echoing a redirect destination in full. */
function describeOutcome(outcome: FollowedOutcome): string {
  if (outcome.status === "http") return String(outcome.httpStatus);
  // Origin only: a redirect destination is never echoed in full.
  if (outcome.status === "redirect_refused") {
    return `redirected out of scope (${originOf(outcome.destination) ?? "unreadable destination"})`;
  }
  if (outcome.status === "too_many_redirects") return `more than ${SITEMAP_JSONLD_MAX_REDIRECTS} redirects`;
  if (outcome.status === "exhausted" || outcome.status === "error") return outcome.reason;
  return outcome.status;
}
