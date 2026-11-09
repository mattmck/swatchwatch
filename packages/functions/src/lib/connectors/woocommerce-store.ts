/**
 * WooCommerce Store API connector (`WooCommerce` protocol: sources named `<Brand>WooCommerce`).
 *
 * Reads a WooCommerce store's public, unauthenticated Store API:
 * `GET {base}/wp-json/wc/store/v1/products?per_page=100&page=N`, page after page until one
 * returns fewer than 100 products or `metadata.maxPages` / `SHOPIFY_CONNECTOR_MAX_PAGES` pages
 * (default 30) were read, 1 s apart (`SHOPIFY_CONNECTOR_PAGE_DELAY_MS`, never below 1000).
 * Before any product request the pull reads `{base}/robots.txt` once: when it disallows the Store
 * API path for us (`lib/robots.ts`: our `SwatchWatch` group, else the `*` group; Disallow prefix
 * rule) the pull throws `WooCommerce Store API disallowed by robots.txt`; a missing robots.txt
 * (any 4xx) allows, a 5xx or network failure after retries fails the pull.
 *
 * Redirects are followed by hand (`redirect: "manual"`, at most `WOOCOMMERCE_MAX_REDIRECTS`
 * hops, each paced): a destination must be on the `base_url` origin and, after robots.txt was
 * read, not disallowed by it, before it is requested; otherwise the pull throws `WooCommerce
 * Store API redirected out of scope: <destination origin>`.
 *
 * The whole catalog is one download per job, cached through `catalogCache`; `pullProducts`
 * windows it by page like the Shopify connector, and the pull that downloaded it reports every
 * product id as the `catalog` (complete only when the last page was reached). The Store API has
 * no GTIN, so `gtin` is always null.
 */

import type { ProductCategory } from "swatchwatch-shared";
import { classifyIngestedProduct, classifyProductCategory } from "../product-category.js";
import { normalizeCurrencyCode, normalizePriceAmount, type ProductPrice } from "../product-price.js";
import { htmlToPlainText, normalizeDescriptors, PRODUCT_DESCRIPTION_MAX_CHARS } from "../product-text.js";
import { isPathDisallowed } from "../robots.js";
import type { SourceSettings } from "../source-settings.js";
import { isRetailerSetSegment, parseConnectorTitle, type RetailerTitle } from "./retailer-title.js";
import { isBundle, resolveConnectorBrand } from "./shopify-generic.js";
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

/** The Store API products route; robots.txt is checked against it. */
export const WOOCOMMERCE_STORE_API_PATH = "/wp-json/wc/store/v1/products";
/** Products per Store API page (the API's maximum). */
export const WOOCOMMERCE_PAGE_SIZE = 100;

/** Pages read per run: `SHOPIFY_CONNECTOR_MAX_PAGES` (default 30), overridden by `metadata.maxPages`. */
function defaultMaxPages(): number {
  return parseIntEnv(process.env.SHOPIFY_CONNECTOR_MAX_PAGES, 30, 1, 200);
}

/** Pause between two requests to the store: `SHOPIFY_CONNECTOR_PAGE_DELAY_MS`, never below 1 s. */
function defaultPageDelayMs(): number {
  return parseIntEnv(process.env.SHOPIFY_CONNECTOR_PAGE_DELAY_MS, 1000, 1000, 10000);
}

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; signal: AbortSignal; redirect?: "manual" }
) => Promise<{
  ok: boolean;
  status: number;
  statusText?: string;
  headers?: { get(name: string): string | null };
  text(): Promise<string>;
}>;

/** Redirect hops followed per request; one more redirect fails the pull. */
export const WOOCOMMERCE_MAX_REDIRECTS = 3;

/** The origin of an absolute URL, or null. */
function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** One Store API product as returned (the record's `raw`); only the fields read are typed. */
export interface WooStoreProduct extends Record<string, unknown> {
  id?: unknown;
  name?: unknown;
  permalink?: unknown;
  sku?: unknown;
  short_description?: unknown;
  description?: unknown;
  prices?: unknown;
  images?: unknown;
  categories?: unknown;
  tags?: unknown;
  brands?: unknown;
  attributes?: unknown;
  has_options?: unknown;
  is_in_stock?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Plain text of a Store API string (names arrive HTML-escaped: `&#8211;`, `&amp;`). */
function plain(value: unknown, maxChars = 500): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return htmlToPlainText(value, maxChars, { sentenceBreaks: false });
}

/** The `name` of each `{ name }` entry of a Store API list (categories, tags, brands, terms). */
function names(value: unknown): string[] {
  return (Array.isArray(value) ? value : []).flatMap((entry) => {
    const name = isRecord(entry) ? plain(entry.name) : null;
    return name ? [name] : [];
  });
}

function attributeList(product: WooStoreProduct): Array<{ name: string | null; taxonomy: string | null; terms: string[] }> {
  return (Array.isArray(product.attributes) ? product.attributes : []).filter(isRecord).map((attribute) => ({
    name: plain(attribute.name),
    taxonomy: typeof attribute.taxonomy === "string" ? attribute.taxonomy : null,
    terms: names(attribute.terms),
  }));
}

/** The first term of a "Brand" attribute (`pa_brand`), if any. */
function brandAttribute(product: WooStoreProduct): string | null {
  const attribute = attributeList(product).find(
    (entry) => entry.name?.toLowerCase() === "brand" || entry.taxonomy === "pa_brand"
  );
  return attribute?.terms[0] ?? null;
}

/** "1200" with `currency_minor_unit` 2 → "12.00" (string arithmetic, no float). */
export function minorUnitsToDecimal(amount: unknown, minorUnit: unknown): string | null {
  const digits = typeof amount === "number" && Number.isInteger(amount) ? String(amount) : amount;
  if (typeof digits !== "string" || !/^\d{1,13}$/.test(digits.trim())) return null;
  const unit = typeof minorUnit === "number" ? minorUnit : Number.parseInt(String(minorUnit ?? ""), 10);
  if (!Number.isInteger(unit) || unit < 0 || unit > 4) return null;
  const padded = digits.trim().padStart(unit + 1, "0");
  const decimal = unit === 0 ? padded : `${padded.slice(0, -unit)}.${padded.slice(-unit)}`;
  return normalizePriceAmount(decimal.replace(/^0+(?=\d)/, ""));
}

/**
 * `{ price, currency }` of a Store API `prices` object: `price` (a variable product's
 * `price_range.min_amount` when present, the lowest variant) in minor units over
 * `currency_minor_unit`, with `currency_code`; both null unless both are valid.
 */
export function wooStorePrice(prices: unknown): ProductPrice {
  const none = { price: null, currency: null };
  if (!isRecord(prices)) return none;
  const range = isRecord(prices.price_range) ? prices.price_range : null;
  const price = minorUnitsToDecimal(range?.min_amount ?? prices.price, prices.currency_minor_unit);
  const currency = normalizeCurrencyCode(prices.currency_code);
  return price && currency ? { price, currency } : none;
}

/** WordPress turns " - " into " &#8211; "; the title parser splits on " - ". */
function hyphenateDashes(title: string): string {
  return title.replace(/\s+[–—]\s+/g, " - ");
}

/** The platform-neutral view the store filters read (`store-filters/types.ts`). */
export function wooStoreFilterProduct(product: WooStoreProduct, brand: string | null): StoreFilterProduct {
  return {
    title: plain(product.name),
    product_type: names(product.categories)[0] ?? null,
    tags: names(product.tags),
    body_html: typeof product.description === "string" ? product.description : null,
    vendor: brand,
  };
}

// ── Gate and records ─────────────────────────────────────────────────────────

interface GatedProduct {
  product: WooStoreProduct;
  externalId: string;
  title: string;
  brand: string;
  category: ProductCategory;
  productType: string | null;
  /** The tags the gate read: the product's tags, then every category after the first. */
  tags: string[];
  listing: RetailerTitle | null;
}

type GateOutcome = { accept: true; gated: GatedProduct } | { accept: false; vendorless?: true };

/**
 * Whether a Store API product is ingested, gated like a Shopify product: an id and a name; no
 * mystery or grab-bag title (`MYSTERY_TITLE_REGEX`, before the category gate); a
 * brand (`settings.brand`, else `brands[0]`, else the "Brand" attribute, read through
 * `resolveConnectorBrand` so `vendorAliases` apply; none = skipped, counted as vendorless); the store filter of the source (`shopifyStoreProductVerdict`, keyed by source
 * name) over `wooStoreFilterProduct`, else the shared gate (`classifyIngestedProduct` over the
 * name, the first category as product type, the tags and the other category names); no bundle
 * tag and no set (gate evidence `set`; a `feed`/`retailer` source also drops a title ending in a
 * set word or one `parseRetailerTitle` reads as a set).
 */
export function gateWooStoreProduct(product: WooStoreProduct, source: string, settings: SourceSettings): GateOutcome {
  const externalId = plain(product.id);
  const title = plain(product.name);
  if (!externalId || !title) return { accept: false };
  // A mystery or grab bag is never one shade, even under a "Nail Polish" category.
  if (MYSTERY_TITLE_REGEX.test(title)) return { accept: false };
  const brand = resolveConnectorBrand(settings.brand ?? names(product.brands)[0] ?? brandAttribute(product), settings);
  if (!brand) return { accept: false, vendorless: true };

  const categories = names(product.categories);
  const productType = categories[0] ?? null;
  const tags = [...names(product.tags), ...categories.slice(1)];
  const gate = classifyIngestedProduct({ title, productType, tags });
  const storeVerdict = shopifyStoreProductVerdict(source, wooStoreFilterProduct(product, brand), settings);
  if (!(storeVerdict ?? gate.accept) || isBundle(tags) || gate.evidence === "set") {
    return { accept: false };
  }
  // As in the Shopify gate: a store filter keeping a product the June tag blocklist rejected
  // gets the rule category, not the gate's "accessory".
  const category =
    storeVerdict === true && gate.evidence === "legacy-tag"
      ? classifyProductCategory({ shadeName: title, products: [{ productType, tags }] }).category
      : gate.category;

  const parseable = hyphenateDashes(title);
  const listing = parseConnectorTitle(parseable, brand, settings.kind, names(product.brands)[0] ?? brandAttribute(product));
  if (settings.kind !== "brand" && (isRetailerSetSegment(parseable) || !listing || listing.isSet)) {
    return { accept: false };
  }
  return { accept: true, gated: { product, externalId, title, brand, category, productType, tags, listing } };
}

/** The connector record for a product `gateWooStoreProduct` accepted. */
export function buildWooStoreRecord(gated: GatedProduct, settings: SourceSettings): ConnectorProductRecord {
  const { product, externalId, title, brand, category, productType, tags, listing } = gated;
  const imageUrls = [
    ...new Set(
      (Array.isArray(product.images) ? product.images : []).flatMap((image) =>
        isRecord(image) && typeof image.src === "string" && image.src.trim() ? [image.src.trim()] : []
      )
    ),
  ];
  const { price, currency } = wooStorePrice(product.prices);
  const attributeTerms = attributeList(product)
    .filter((attribute) => attribute.name?.toLowerCase() !== "brand" && attribute.taxonomy !== "pa_brand")
    .flatMap((attribute) => attribute.terms);
  const description =
    htmlToPlainText(product.short_description, PRODUCT_DESCRIPTION_MAX_CHARS) ??
    htmlToPlainText(product.description, PRODUCT_DESCRIPTION_MAX_CHARS);
  return {
    externalId,
    gtin: null,
    raw: product,
    normalized: {
      productId: externalId,
      brand,
      // The parsed shade name ("Picture Polish – Atomic" → "Atomic"); brand mode keeps it too.
      name: listing?.shadeName ?? title,
      rawTitle: title,
      productLine: listing?.productLine ?? null,
      // Only a "#CODE" parsed from the title becomes `vendorCode` (and so a shade alias); the
      // store's SKU is its own stock code and stays in `sku`.
      vendorCode: listing?.vendorCode ?? null,
      sku: plain(product.sku),
      productType,
      // Connector-gate category (#349); materialization re-classifies with the shade's finishes.
      productCategory: category,
      tags,
      finishes: [],
      collections: [],
      descriptors: normalizeDescriptors([...attributeTerms, ...names(product.categories)]),
      descriptionText: description,
      imageUrls,
      primaryImageUrl: imageUrls[0] ?? null,
      productUrl: typeof product.permalink === "string" && product.permalink.trim() ? product.permalink.trim() : null,
      price,
      currency,
      available: typeof product.is_in_stock === "boolean" ? product.is_in_stock : null,
      hasOptions: product.has_options === true,
      kind: settings.kind,
      ...(settings.kind !== "brand" ? { listingTitle: title } : {}),
    },
  };
}

const SEARCH_TERMS_MEANING_ALL = new Set(["", "nail polish", "nail_polish", "nailpolish", "all", "*", "recent", "latest", "new"]);

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function isRetryableRequestError(error: Error): boolean {
  if (error.name === "AbortError") return true;
  const message = error.message.toLowerCase();
  return ["timed out", "fetch failed", "econnreset", "econnrefused", "etimedout", "enotfound", "eai_again"].some(
    (needle) => message.includes(needle)
  );
}

// ── Connector ────────────────────────────────────────────────────────────────

export interface WooCommerceStoreConnectorOptions {
  /** Injected in tests; defaults to the global fetch. */
  fetchImpl?: FetchLike;
  /** Injected in tests (a fake clock); default `Date.now` and `setTimeout`. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Override the env-derived pause between requests (tests). */
  pageDelayMs?: number;
}

interface FetchedCatalog {
  products: WooStoreProduct[];
  complete: boolean;
  pagesFetched: number;
}

export class WooCommerceStoreConnector implements ProductConnector {
  readonly source: SupportedConnectorSource;
  private readonly baseUrl: string;
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
    options: WooCommerceStoreConnectorOptions = {}
  ) {
    const base = baseUrl?.trim().replace(/\/+$/, "");
    if (!base) throw new Error(`${source}: data_source.base_url is required`);
    this.source = source;
    this.baseUrl = base;
    this.settings = settings;
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.pageDelayMs = options.pageDelayMs ?? defaultPageDelayMs();
  }

  async pullProducts(options: ConnectorPullOptions): Promise<ConnectorPullResult> {
    // Set only when this pull downloaded the catalog: a cached catalog reports no `catalog`, so
    // listing freshness runs once, on the download.
    let fetched: FetchedCatalog | null = null;
    const products = await loadCatalogWithCache<WooStoreProduct>(options.catalogCache, async () => {
      fetched = await this.fetchCatalog();
      return fetched.products;
    });
    const download = fetched as FetchedCatalog | null;

    const gated: GatedProduct[] = [];
    let vendorlessSkipped = 0;
    for (const product of products) {
      const outcome = gateWooStoreProduct(product, this.source, this.settings);
      if (outcome.accept) gated.push(outcome.gated);
      else if (outcome.vendorless) vendorlessSkipped += 1;
    }

    const term = options.searchTerm.trim().toLowerCase();
    const textFilter = SEARCH_TERMS_MEANING_ALL.has(term) ? null : term;
    const filtered = textFilter
      ? gated.filter((entry) =>
          [entry.title, entry.brand, entry.productType].some((value) => value?.toLowerCase().includes(textFilter))
        )
      : gated;

    // Store order is kept (the Store API lists newest first); the page window is the only slice.
    const offset = Math.max(0, (options.page - 1) * options.pageSize);
    const windowed = filtered.slice(offset, offset + options.pageSize).slice(0, options.maxRecords);
    const records = windowed.map((entry) => buildWooStoreRecord(entry, this.settings));

    const catalogIds = download
      ? [...new Set(products.map((product) => plain(product.id)).filter((id): id is string => id !== null))]
      : [];

    return {
      source: this.source,
      records,
      ...(download ? { catalog: { externalIds: catalogIds, complete: download.complete && catalogIds.length > 0 } } : {}),
      metadata: {
        requestUrl: `${this.baseUrl}${WOOCOMMERCE_STORE_API_PATH}`,
        storeBaseUrl: this.baseUrl,
        responsePage: options.page,
        responsePageSize: options.pageSize,
        sourceCount: filtered.length,
        sourcePageCount: options.pageSize > 0 ? Math.ceil(filtered.length / options.pageSize) : null,
        fetchedProductCount: products.length,
        storePagesFetched: download?.pagesFetched ?? null,
        catalogReachedEnd: download?.complete ?? null,
        textFilter,
        connectorType: "woocommerce-store",
        sourceKind: this.settings.kind,
        vendorlessSkipped,
      },
    };
  }

  /**
   * robots.txt once, then the Store API pages until a short page, the last page `X-WP-TotalPages`
   * names, a 400/404 on the page after a full one (WordPress answers an out-of-range page with
   * `rest_post_invalid_page_number`), or the page cap. That 400/404 ends the catalog only when the
   * previous page sent no `X-WP-TotalPages` or the page is past it; when the header says the page
   * exists, the error fails the pull (a truncated catalog would mark the rest missing).
   */
  private async fetchCatalog(): Promise<FetchedCatalog> {
    const robotsBody = await this.assertRobotsAllow();
    const maxPages = this.settings.maxPages ?? defaultMaxPages();
    const products: WooStoreProduct[] = [];
    let totalPages: number | null = null;
    for (let page = 1; page <= maxPages; page += 1) {
      const url = `${this.baseUrl}${WOOCOMMERCE_STORE_API_PATH}?per_page=${WOOCOMMERCE_PAGE_SIZE}&page=${page}`;
      const response = await this.requestFollowingRedirects(url, "application/json", robotsBody);
      if (!response.ok && page > 1 && (response.status === 400 || response.status === 404)) {
        if (totalPages !== null && page <= totalPages) {
          throw new Error(
            `${this.source} Store API request failed: HTTP ${response.status} (page ${page} of ${totalPages} per X-WP-TotalPages)`
          );
        }
        // The previous page was full and this one is out of range: the catalog ended there.
        return { products, complete: true, pagesFetched: page - 1 };
      }
      if (!response.ok) {
        throw new Error(`${this.source} Store API request failed: HTTP ${response.status} (page ${page})`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(response.body);
      } catch {
        throw new Error(`${this.source} Store API page ${page} is not JSON`);
      }
      if (!Array.isArray(parsed)) throw new Error(`${this.source} Store API page ${page} is not a product array`);
      products.push(...parsed.filter(isRecord));
      totalPages = response.totalPages;
      if (parsed.length < WOOCOMMERCE_PAGE_SIZE || (response.totalPages !== null && page >= response.totalPages)) {
        if (products.length === 0) throw new Error(`${this.source} Store API returned no products`);
        return { products, complete: true, pagesFetched: page };
      }
    }
    console.warn(`${this.source} Store API stopped at the page cap (${maxPages} pages); the catalog may be incomplete`);
    return { products, complete: false, pagesFetched: maxPages };
  }

  /** Reads robots.txt (same-origin redirects only) and returns its body; null when missing. */
  private async assertRobotsAllow(): Promise<string | null> {
    const response = await this.requestFollowingRedirects(`${this.baseUrl}/robots.txt`, "text/plain, */*;q=0.5", null);
    // A missing robots.txt (404, or any other 4xx) allows everything (RFC 9309).
    if (!response.ok) return null;
    if (isPathDisallowed(response.body, ROBOTS_AGENT_TOKEN, WOOCOMMERCE_STORE_API_PATH)) {
      throw new Error("WooCommerce Store API disallowed by robots.txt");
    }
    return response.body;
  }

  /**
   * `request`, following up to `WOOCOMMERCE_MAX_REDIRECTS` redirects by hand. A destination must
   * share the `base_url` origin and pass `robotsBody` (null = allow) before it is requested;
   * otherwise, or after one hop too many, the pull fails. Errors name the destination's origin only.
   */
  private async requestFollowingRedirects(
    url: string,
    accept: string,
    robotsBody: string | null
  ): Promise<{ ok: boolean; status: number; body: string; totalPages: number | null }> {
    const baseOrigin = originOf(this.baseUrl);
    let current = url;
    for (let hops = 0; ; hops += 1) {
      const response = await this.request(current, accept);
      if (!response.location) return response;
      let destination: URL;
      try {
        destination = new URL(response.location, current);
      } catch {
        throw new Error(`${this.source} Store API request failed: HTTP ${response.status} with an unreadable Location`);
      }
      if (hops >= WOOCOMMERCE_MAX_REDIRECTS) {
        throw new Error(`WooCommerce Store API: more than ${WOOCOMMERCE_MAX_REDIRECTS} redirects`);
      }
      const inScope =
        baseOrigin !== null &&
        destination.origin === baseOrigin &&
        (robotsBody === null || !isPathDisallowed(robotsBody, ROBOTS_AGENT_TOKEN, destination.pathname));
      if (!inScope) throw new Error(`WooCommerce Store API redirected out of scope: ${destination.origin}`);
      current = destination.toString();
    }
  }

  /**
   * One GET, paced at least `pageDelayMs` after the previous request, retried on 408/425/429/5xx
   * and network errors with linear backoff. Returns the final response (ok or a non-retryable
   * status); throws when a retryable failure persists or on any other thrown error.
   */
  private async request(
    url: string,
    accept: string
  ): Promise<{ ok: boolean; status: number; body: string; totalPages: number | null; location: string | null }> {
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
          headers: { Accept: accept, "User-Agent": USER_AGENT },
          signal: controller.signal,
          redirect: "manual",
        });
        if (response.ok || !isRetryableStatus(response.status)) {
          const location =
            response.status >= 300 && response.status < 400 ? (response.headers?.get("location") ?? null) : null;
          const totalPagesHeader = response.headers?.get("x-wp-totalpages") ?? null;
          const totalPages = totalPagesHeader && /^\d+$/.test(totalPagesHeader.trim()) ? Number(totalPagesHeader.trim()) : null;
          return {
            ok: response.ok,
            status: response.status,
            body: response.ok ? await response.text() : "",
            totalPages: totalPages && totalPages > 0 ? totalPages : null,
            location: location || null,
          };
        }
        retryReason = `HTTP ${response.status}`;
        lastError = new Error(`${this.source} request failed: HTTP ${response.status} ${response.statusText ?? ""}`.trim());
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
