/**
 * Big Cartel connector (`BigCartel` protocol: sources named `<Brand>BigCartel`).
 *
 * Reads a Big Cartel store through the public, read-only v0 API
 * (developers.bigcartel.com/api/v0): one `GET https://api.bigcartel.com/{subdomain}/products.json`
 * (the whole catalog, no pagination), then `GET …/store.json` once, 1 s later
 * (`SHOPIFY_CONNECTOR_PAGE_DELAY_MS`, never below 1000), for the store's `url` (product `url`s
 * are relative) and `currency.code` (`metadata.currency` overrides it). A failed store.json is not
 * fatal: product URLs then resolve against `data_source.base_url`, else
 * `https://{subdomain}.bigcartel.com`, and the currency is `metadata.currency` or none.
 *
 * Every source names its maker in `metadata.brand` (a Big Cartel product has no vendor field);
 * the factory refuses a source without one. The download (products plus the store facts) is
 * cached per job through `catalogCache`, and the pull that downloaded it reports every permalink
 * as a complete `catalog`. The v0 API has no GTIN, so `gtin` is always null.
 */

import type { ProductCategory } from "swatchwatch-shared";
import { classifyProductCategory } from "../product-category.js";
import { normalizeCurrencyCode, normalizePriceAmount } from "../product-price.js";
import { htmlToPlainText, normalizeDescriptors, PRODUCT_DESCRIPTION_MAX_CHARS } from "../product-text.js";
import type { SourceSettings } from "../source-settings.js";
import { isRetailerSetSegment, parseConnectorTitle, type RetailerTitle } from "./retailer-title.js";
import { isBundle, resolveConnectorBrand } from "./shopify-generic.js";
import { classifyWithStoreShadeName, shopifyStoreShadeName } from "./shopify-title.js";
import { shopifyStoreProductVerdict } from "./store-filters/index.js";
import { MYSTERY_TITLE_REGEX } from "./store-filters/shared.js";
import type { StoreFilterProduct } from "./store-filters/types.js";
import {
  ConnectorProductRecord,
  ConnectorPullOptions,
  ConnectorPullResult,
  loadCatalogWithCache,
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

/** The v0 API origin; a store is `{origin}/{subdomain}`. */
export const BIG_CARTEL_API_ORIGIN = "https://api.bigcartel.com";
/** A Big Cartel subdomain: letters, digits and hyphens only (it is a URL path segment). */
const SUBDOMAIN_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,62})$/i;

/** Pause between two requests to the API: `SHOPIFY_CONNECTOR_PAGE_DELAY_MS`, never below 1 s. */
function defaultPageDelayMs(): number {
  return parseIntEnv(process.env.SHOPIFY_CONNECTOR_PAGE_DELAY_MS, 1000, 1000, 10000);
}

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; signal: AbortSignal }
) => Promise<{ ok: boolean; status: number; statusText?: string; text(): Promise<string> }>;

/** One v0 product as returned (the record's `raw`); only the fields read are typed. */
export interface BigCartelProduct extends Record<string, unknown> {
  name?: unknown;
  permalink?: unknown;
  url?: unknown;
  description?: unknown;
  price?: unknown;
  default_price?: unknown;
  status?: unknown;
  options?: unknown;
  images?: unknown;
  categories?: unknown;
}

/** The store facts a download read from store.json (null when it could not be read). */
export interface BigCartelStoreFacts {
  url: string | null;
  currency: string | null;
}

/** What the job's catalog cache holds per product: the product and the store facts. */
interface CachedProduct {
  product: BigCartelProduct;
  store: BigCartelStoreFacts;
}

/** Type guard for a plain object (not null, not an array). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Plain text of a v0 API value: a number as a string, HTML stripped and truncated to `maxChars`; null when empty. */
function plain(value: unknown, maxChars = 500): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return htmlToPlainText(value, maxChars, { sentenceBreaks: false });
}

/** The `name` of each `{ name }` entry of a v0 list (categories, options). */
function names(value: unknown): string[] {
  return (Array.isArray(value) ? value : []).flatMap((entry) => {
    const name = isRecord(entry) ? plain(entry.name) : null;
    return name ? [name] : [];
  });
}

/** An absolute http(s) URL, or null. */
function httpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** A product `url` resolved against the store URL: a relative one becomes absolute, an absolute one is kept. */
export function resolveBigCartelProductUrl(url: unknown, storeUrl: string): string | null {
  if (typeof url !== "string" || !url.trim()) return null;
  try {
    const resolved = new URL(url.trim(), storeUrl.endsWith("/") ? storeUrl : `${storeUrl}/`);
    return resolved.protocol === "https:" || resolved.protocol === "http:" ? resolved.toString() : null;
  } catch {
    return null;
  }
}

/** The platform-neutral view the store filters read (`store-filters/types.ts`). */
export function bigCartelStoreFilterProduct(product: BigCartelProduct, brand: string | null): StoreFilterProduct {
  return {
    title: plain(product.name),
    product_type: names(product.categories)[0] ?? null,
    tags: names(product.categories),
    handle: typeof product.permalink === "string" ? product.permalink : null,
    body_html: typeof product.description === "string" ? product.description : null,
    vendor: brand,
  };
}

// ── Gate and records ─────────────────────────────────────────────────────────

interface GatedProduct {
  entry: CachedProduct;
  externalId: string;
  title: string;
  brand: string;
  category: ProductCategory;
  categories: string[];
  listing: RetailerTitle | null;
}

type GateOutcome = { accept: true; gated: GatedProduct } | { accept: false; vendorless?: true };

/**
 * Whether a v0 product is ingested: a permalink and a name; no mystery or grab-bag title
 * (`MYSTERY_TITLE_REGEX`, before the category gate: a "Nail Polish" category carries a polish
 * signal); a brand (`settings.brand` through `resolveConnectorBrand`, so `vendorAliases` apply;
 * none = skipped, counted as vendorless); the store filter of
 * the source (`shopifyStoreProductVerdict`) over `bigCartelStoreFilterProduct`, else the shared
 * gate (`classifyIngestedProduct` over the name, the first category as product type and every
 * category as a tag); no bundle tag and no set (gate evidence `set`; a `feed`/`retailer` source
 * also drops a title ending in a set word or one `parseRetailerTitle` reads as a set). The shade
 * name is the source's store title parser (`shopifyStoreShadeName`) when it has one that
 * answers, else `parseConnectorTitle`.
 */
export function gateBigCartelProduct(entry: CachedProduct, source: string, settings: SourceSettings): GateOutcome {
  const { product } = entry;
  const externalId = plain(product.permalink);
  const title = plain(product.name);
  if (!externalId || !title) return { accept: false };
  if (MYSTERY_TITLE_REGEX.test(title)) return { accept: false };
  const brand = resolveConnectorBrand(settings.brand, settings);
  if (!brand) return { accept: false, vendorless: true };

  const categories = names(product.categories);
  const productType = categories[0] ?? null;
  const filterProduct = bigCartelStoreFilterProduct(product, brand);
  // A store title parser (keyed by source name, `SHOPIFY_STORE_TITLE_PARSERS`) names the shade
  // when the store's titles carry stock or finish notes. The gate classifies the raw title, unless
  // only the note the parser dropped reads as set wording ("(FINAL 3 BOTTLES)" → "3 bottles").
  const storeShadeName = shopifyStoreShadeName(source, filterProduct);
  const { gate, shadeText } = classifyWithStoreShadeName(title, storeShadeName, productType, categories);
  const storeVerdict = shopifyStoreProductVerdict(source, filterProduct, settings);
  if (!(storeVerdict ?? gate.accept) || isBundle(categories) || gate.evidence === "set") {
    return { accept: false };
  }
  const category =
    storeVerdict === true && gate.evidence === "legacy-tag"
      ? classifyProductCategory({ shadeName: shadeText, products: [{ productType, tags: categories }] }).category
      : gate.category;

  const listing: RetailerTitle | null = storeShadeName
    ? { shadeName: storeShadeName, productLine: null, vendorCode: null, isSet: false }
    : parseConnectorTitle(title, brand, settings.kind);
  if (settings.kind !== "brand" && (isRetailerSetSegment(title) || !listing || listing.isSet)) {
    return { accept: false };
  }
  return { accept: true, gated: { entry, externalId, title, brand, category, categories, listing } };
}

/** The connector record for a product `gateBigCartelProduct` accepted; `fallbackStoreUrl` when store.json named none. */
export function buildBigCartelRecord(
  gated: GatedProduct,
  settings: SourceSettings,
  fallbackStoreUrl: string
): ConnectorProductRecord {
  const { entry, externalId, title, brand, category, categories, listing } = gated;
  const { product, store } = entry;
  const imageUrls = [
    ...new Set(
      (Array.isArray(product.images) ? product.images : []).flatMap((image) =>
        isRecord(image) && typeof image.secure_url === "string" && image.secure_url.trim() ? [image.secure_url.trim()] : []
      )
    ),
  ];
  const price = normalizePriceAmount(product.default_price ?? product.price);
  const currency = normalizeCurrencyCode(settings.currency) ?? normalizeCurrencyCode(store.currency);
  // A single-option product's option is named "Default": not a descriptor.
  const optionNames = names(product.options).filter((name) => name.toLowerCase() !== "default");
  return {
    externalId,
    gtin: null,
    raw: product,
    normalized: {
      productId: externalId,
      brand,
      name: listing?.shadeName ?? title,
      rawTitle: title,
      productLine: listing?.productLine ?? null,
      vendorCode: listing?.vendorCode ?? null,
      productType: categories[0] ?? null,
      // Connector-gate category (#349); materialization re-classifies with the shade's finishes.
      productCategory: category,
      tags: categories,
      finishes: [],
      collections: [],
      descriptors: normalizeDescriptors([...optionNames, ...categories]),
      descriptionText: htmlToPlainText(product.description, PRODUCT_DESCRIPTION_MAX_CHARS),
      imageUrls,
      primaryImageUrl: imageUrls[0] ?? null,
      productUrl: resolveBigCartelProductUrl(product.url, store.url ?? fallbackStoreUrl),
      price: price && currency ? price : null,
      currency: price && currency ? currency : null,
      available: typeof product.status === "string" ? product.status === "active" : null,
      kind: settings.kind,
      ...(settings.kind !== "brand" ? { listingTitle: title } : {}),
    },
  };
}

/** `{ url, currency }` of a store.json body (`currency` is an object in v0: `{ code, name, sign }`). */
export function parseBigCartelStore(body: unknown): BigCartelStoreFacts {
  if (!isRecord(body)) return { url: null, currency: null };
  const url = typeof body.url === "string" ? httpUrl(body.url.trim()) : null;
  const code = isRecord(body.currency) ? body.currency.code : body.currency;
  return { url: url ? url.replace(/\/+$/, "") : null, currency: normalizeCurrencyCode(code) };
}

const SEARCH_TERMS_MEANING_ALL = new Set(["", "nail polish", "nail_polish", "nailpolish", "all", "*", "recent", "latest", "new"]);

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

// ── Connector ────────────────────────────────────────────────────────────────

export interface BigCartelConnectorOptions {
  /** Injected in tests; defaults to the global fetch. */
  fetchImpl?: FetchLike;
  /** Injected in tests (a fake clock); default `Date.now` and `setTimeout`. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Override the env-derived pause between requests (tests). */
  pageDelayMs?: number;
}

export class BigCartelConnector implements ProductConnector {
  readonly source: SupportedConnectorSource;
  private readonly apiBase: string;
  private readonly fallbackStoreUrl: string;
  private readonly settings: SourceSettings;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pageDelayMs: number;
  private lastRequestAt: number | null = null;

  constructor(
    source: SupportedConnectorSource,
    baseUrl: string | null | undefined,
    settings: SourceSettings,
    options: BigCartelConnectorOptions = {}
  ) {
    if (!settings.subdomain) throw new Error(`${source}: metadata.subdomain is required`);
    if (!SUBDOMAIN_REGEX.test(settings.subdomain)) {
      throw new Error(`${source}: metadata.subdomain must be a Big Cartel subdomain (letters, digits, hyphens)`);
    }
    if (!settings.brand) throw new Error(`BigCartel source ${source} has no metadata.brand`);
    const subdomain = settings.subdomain.toLowerCase();
    this.source = source;
    this.apiBase = `${BIG_CARTEL_API_ORIGIN}/${subdomain}`;
    const base = baseUrl?.trim() ? httpUrl(baseUrl.trim()) : null;
    this.fallbackStoreUrl = (base ?? `https://${subdomain}.bigcartel.com`).replace(/\/+$/, "");
    this.settings = settings;
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.pageDelayMs = options.pageDelayMs ?? defaultPageDelayMs();
  }

  async pullProducts(options: ConnectorPullOptions): Promise<ConnectorPullResult> {
    // Set only when this pull downloaded the catalog (a cached catalog reports no `catalog`).
    let downloaded: { storeJsonRead: boolean } | null = null;
    const entries = await loadCatalogWithCache<CachedProduct>(options.catalogCache, async () => {
      const fetched = await this.fetchCatalog();
      downloaded = { storeJsonRead: fetched.storeJsonRead };
      return fetched.entries;
    });
    const download = downloaded as { storeJsonRead: boolean } | null;

    const gated: GatedProduct[] = [];
    let vendorlessSkipped = 0;
    for (const entry of entries) {
      const outcome = gateBigCartelProduct(entry, this.source, this.settings);
      if (outcome.accept) gated.push(outcome.gated);
      else if (outcome.vendorless) vendorlessSkipped += 1;
    }

    const term = options.searchTerm.trim().toLowerCase();
    const textFilter = SEARCH_TERMS_MEANING_ALL.has(term) ? null : term;
    const filtered = textFilter
      ? gated.filter((entry) =>
          [entry.title, entry.brand, ...entry.categories].some((value) => value.toLowerCase().includes(textFilter))
        )
      : gated;

    // Store order is kept (products.json lists them by `position`); the page window is the only slice.
    const offset = Math.max(0, (options.page - 1) * options.pageSize);
    const windowed = filtered.slice(offset, offset + options.pageSize).slice(0, options.maxRecords);
    const records = windowed.map((entry) => buildBigCartelRecord(entry, this.settings, this.fallbackStoreUrl));

    const catalogIds = download
      ? [...new Set(entries.map((entry) => plain(entry.product.permalink)).filter((id): id is string => id !== null))]
      : [];

    return {
      source: this.source,
      records,
      ...(download ? { catalog: { externalIds: catalogIds, complete: catalogIds.length > 0 } } : {}),
      metadata: {
        requestUrl: `${this.apiBase}/products.json`,
        storeUrl: entries[0]?.store.url ?? this.fallbackStoreUrl,
        responsePage: options.page,
        responsePageSize: options.pageSize,
        sourceCount: filtered.length,
        sourcePageCount: options.pageSize > 0 ? Math.ceil(filtered.length / options.pageSize) : null,
        fetchedProductCount: entries.length,
        storeJsonRead: download?.storeJsonRead ?? null,
        textFilter,
        connectorType: "big-cartel",
        sourceKind: this.settings.kind,
        vendorlessSkipped,
      },
    };
  }

  /** products.json (the whole catalog), then store.json once for the store URL and currency. */
  private async fetchCatalog(): Promise<{ entries: CachedProduct[]; storeJsonRead: boolean }> {
    const response = await this.request(`${this.apiBase}/products.json`);
    if (!response.ok) throw new Error(`${this.source} Big Cartel API request failed: HTTP ${response.status}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      throw new Error(`${this.source} Big Cartel products.json is not JSON`);
    }
    if (!Array.isArray(parsed)) throw new Error(`${this.source} Big Cartel products.json is not a product array`);
    const products = parsed.filter(isRecord) as BigCartelProduct[];
    if (products.length === 0) throw new Error(`${this.source} Big Cartel API returned no products`);

    let store: BigCartelStoreFacts = { url: null, currency: null };
    let storeJsonRead = false;
    try {
      const storeResponse = await this.request(`${this.apiBase}/store.json`);
      if (storeResponse.ok) {
        store = parseBigCartelStore(JSON.parse(storeResponse.body));
        storeJsonRead = true;
      } else {
        console.warn(`${this.source} Big Cartel store.json answered HTTP ${storeResponse.status}; using the fallback store URL`);
      }
    } catch (error) {
      console.warn(`${this.source} Big Cartel store.json could not be read; using the fallback store URL`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return { entries: products.map((product) => ({ product, store })), storeJsonRead };
  }

  /**
   * One GET, paced at least `pageDelayMs` after the previous request, retried on 408/425/429/5xx
   * and network errors with linear backoff. Returns the final response (ok or a non-retryable
   * status); throws when a retryable failure persists or on any other thrown error.
   */
  private async request(url: string): Promise<{ ok: boolean; status: number; body: string }> {
    const attemptCount = MAX_REQUEST_RETRIES + 1;
    let backoffMs = 0;
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= attemptCount; attempt += 1) {
      const paceMs = this.lastRequestAt === null ? 0 : Math.max(0, this.lastRequestAt + this.pageDelayMs - this.now());
      const waitMs = Math.max(paceMs, backoffMs);
      if (waitMs > 0) await this.sleep(waitMs);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      this.lastRequestAt = this.now();
      let retryReason: string;
      try {
        const response = await this.fetchImpl(url, {
          method: "GET",
          headers: { Accept: "application/json", "User-Agent": USER_AGENT },
          signal: controller.signal,
        });
        if (response.ok || !isRetryableStatus(response.status)) {
          return { ok: response.ok, status: response.status, body: response.ok ? await response.text() : "" };
        }
        retryReason = `HTTP ${response.status}`;
        lastError = new Error(`${this.source} Big Cartel API request failed: HTTP ${response.status} ${response.statusText ?? ""}`.trim());
      } catch (error) {
        let normalized = error instanceof Error ? error : new Error(String(error));
        if (normalized.name === "AbortError") {
          normalized = new Error(`${this.source} request timed out after ${REQUEST_TIMEOUT_MS}ms`);
        }
        if (!isRetryableRequestError(normalized)) throw normalized;
        retryReason = normalized.message;
        lastError = normalized;
      } finally {
        clearTimeout(timeout);
      }
      if (attempt >= attemptCount) break;
      backoffMs = RETRY_BASE_DELAY_MS * attempt;
      console.warn(`${this.source} retry ${attempt}/${MAX_REQUEST_RETRIES} after ${retryReason}; waiting ${backoffMs}ms`, { url });
    }
    throw lastError ?? new Error(`${this.source} request failed`);
  }
}
