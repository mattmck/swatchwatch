/**
 * Google product feed connector (`ProductFeed` protocol: sources named `<Brand>Feed`).
 *
 * Reads a Google Merchant Center product feed: XML (RSS 2.0 `channel/item` or Atom `entry`, with
 * the `g:` namespace, http://base.google.com/ns/1.0) or delimited text (first row = attribute
 * names, tab or comma separated). The feed URL is `data_source.base_url` unless
 * `metadata.feedUrl` overrides it; `metadata.feedAuthEnv` names an env var holding `user:pass`,
 * sent as HTTP basic auth (`PRODUCT_FEED_AUTH_<SOURCE>`, never logged).
 *
 * The whole feed is one download, cached per job through `catalogCache`; `pullProducts` windows
 * it by page like the Shopify connector. Every record carries `normalized.available`
 * (`g:availability`: true for "in stock", false for any other value, null when missing), the
 * availability contract `BUY_LINK_CANDIDATES_SQL` reads first.
 */

import { XMLParser } from "fast-xml-parser";
import type { ProductCategory } from "swatchwatch-shared";
import { normalizeGtin } from "../barcodes.js";
import { classifyIngestedProduct } from "../product-category.js";
import { normalizeCurrencyCode, normalizePriceAmount, type ProductPrice } from "../product-price.js";
import { htmlToPlainText, normalizeDescriptors, PRODUCT_DESCRIPTION_MAX_CHARS } from "../product-text.js";
import type { SourceSettings } from "../source-settings.js";
import { isRetailerSetSegment, parseRetailerTitle, type RetailerTitle } from "./retailer-title.js";
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
const GOOGLE_NAMESPACE = "http://base.google.com/ns/1.0";

/** One feed item: attribute name (without the `g:` prefix) → value, or values when repeated. */
export type FeedItem = Record<string, string | string[]>;

export type FeedFormat = "xml" | "delimited";

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; signal: AbortSignal }
) => Promise<{
  ok: boolean;
  status: number;
  statusText?: string;
  headers?: { get(name: string): string | null } | null;
  text(): Promise<string>;
}>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

// ── Parsing ────────────────────────────────────────────────────────────────────

function textOf(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    // An element with attributes: its text, or an Atom <link href="..."/>.
    return textOf(record["#text"]) ?? textOf(record["@_href"]);
  }
  return null;
}

function addValue(item: FeedItem, key: string, value: string): void {
  const existing = item[key];
  if (existing === undefined) item[key] = value;
  else if (Array.isArray(existing)) existing.push(value);
  else item[key] = [existing, value];
}

/** Attribute key as stored: lower-cased, spaces as underscores (`image link` → `image_link`). */
function attributeKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "_");
}

/** The prefixes bound to the Google namespace on the root element (usually just `g`). */
function googlePrefixes(root: Record<string, unknown>): string[] {
  const prefixes = new Set(["g"]);
  for (const [key, value] of Object.entries(root)) {
    if (key.startsWith("@_xmlns:") && value === GOOGLE_NAMESPACE) prefixes.add(key.slice("@_xmlns:".length));
  }
  return [...prefixes];
}

/**
 * An XML item/entry as a `FeedItem`: Google-namespace elements win over plain ones of the same
 * name (RSS `<title>` vs `<g:title>`); elements in other namespaces are ignored.
 */
function xmlItem(element: Record<string, unknown>, prefixes: readonly string[]): FeedItem {
  const google: FeedItem = {};
  const plain: FeedItem = {};
  for (const [name, raw] of Object.entries(element)) {
    if (name.startsWith("@_") || name === "#text") continue;
    const colon = name.indexOf(":");
    const prefix = colon >= 0 ? name.slice(0, colon) : null;
    if (prefix !== null && !prefixes.includes(prefix)) continue;
    const target = prefix === null ? plain : google;
    const key = attributeKey(colon >= 0 ? name.slice(colon + 1) : name);
    for (const entry of Array.isArray(raw) ? raw : [raw]) {
      const text = textOf(entry);
      if (text !== null) addValue(target, key, text);
    }
  }
  return { ...plain, ...google };
}

function parseXmlFeed(body: string): FeedItem[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    // Keep every value a string: a GTIN's leading zeros and a price's trailing zero matter.
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
    isArray: (_name, jpath) => jpath === "rss.channel.item" || jpath === "feed.entry",
  });
  const document = parser.parse(body) as Record<string, unknown>;
  const rss = document.rss as Record<string, unknown> | undefined;
  const atom = document.feed as Record<string, unknown> | undefined;
  let root: Record<string, unknown>;
  let elements: unknown;
  if (rss && typeof rss === "object") {
    root = rss;
    const channel = rss.channel as Record<string, unknown> | undefined;
    elements = channel && typeof channel === "object" ? channel.item : undefined;
  } else if (atom && typeof atom === "object") {
    root = atom;
    elements = atom.entry;
  } else {
    throw new Error("Product feed XML has neither an RSS <rss><channel> nor an Atom <feed> root");
  }
  const prefixes = googlePrefixes(root);
  return (Array.isArray(elements) ? elements : [])
    .filter((element): element is Record<string, unknown> => Boolean(element) && typeof element === "object")
    .map((element) => xmlItem(element, prefixes));
}

/** RFC 4180-style rows: quoted fields may hold the delimiter, newlines and doubled quotes. */
function parseDelimitedRows(body: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let fieldStart = true;
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (quoted) {
      if (char === '"') {
        if (body[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && fieldStart) {
      quoted = true;
      fieldStart = false;
    } else if (char === delimiter) {
      row.push(field);
      field = "";
      fieldStart = true;
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && body[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      fieldStart = true;
    } else {
      field += char;
      fieldStart = false;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
}

/** Attributes Google lets a delimited feed list several values of in one comma-separated cell. */
const MULTI_VALUE_ATTRIBUTES: ReadonlySet<string> = new Set(["additional_image_link"]);

function parseDelimitedFeed(body: string): FeedItem[] {
  const text = body.replace(/^\uFEFF/, "");
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const delimiter = firstLine.includes("\t") ? "\t" : ",";
  const [header, ...rows] = parseDelimitedRows(text, delimiter);
  if (!header) return [];
  const keys = header.map((name) => attributeKey(name.replace(/^g:/i, "")));
  return rows.map((cells) => {
    const item: FeedItem = {};
    keys.forEach((key, index) => {
      const value = (cells[index] ?? "").trim();
      if (!key || !value) return;
      const values = MULTI_VALUE_ATTRIBUTES.has(key)
        ? value.split(",").map((entry) => entry.trim()).filter(Boolean)
        : [value];
      for (const entry of values) addValue(item, key, entry);
    });
    return item;
  });
}

/** Feed format from the response `Content-Type`, then the URL extension, then the body. */
export function detectFeedFormat(contentType: string | null | undefined, url: string, body: string): FeedFormat {
  const type = (contentType ?? "").toLowerCase();
  if (/\bxml\b|rss|atom/.test(type)) return "xml";
  if (/tab-separated|csv/.test(type)) return "delimited";
  let pathname = url;
  try {
    pathname = new URL(url).pathname;
  } catch {
    // Not an absolute URL: read the extension from the string itself.
  }
  const extension = /\.([a-z0-9]+)$/i.exec(pathname.toLowerCase())?.[1];
  if (extension && ["xml", "rss", "atom"].includes(extension)) return "xml";
  if (extension && ["tsv", "txt", "csv"].includes(extension)) return "delimited";
  return body.trimStart().startsWith("<") ? "xml" : "delimited";
}

/** Parses a downloaded feed into items (`FeedItem`, the record's `raw`). */
export function parseProductFeed(
  body: string,
  contentType: string | null | undefined,
  url: string
): { format: FeedFormat; items: FeedItem[] } {
  const format = detectFeedFormat(contentType, url, body);
  return { format, items: format === "xml" ? parseXmlFeed(body) : parseDelimitedFeed(body) };
}

// ── Item fields ──────────────────────────────────────────────────────────────

function first(item: FeedItem, key: string): string | null {
  const value = item[key];
  const text = Array.isArray(value) ? value[0] : value;
  return typeof text === "string" && text.trim() ? collapse(text) : null;
}

function all(item: FeedItem, key: string): string[] {
  const value = item[key];
  return (Array.isArray(value) ? value : value === undefined ? [] : [value])
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * `{ price, currency }` from a `g:price` value such as `"12.50 USD"` (or `"USD 12.50"`, or a
 * decimal comma `"12,50 EUR"`); both null unless the amount and an ISO 4217 code are present.
 */
export function parseFeedPrice(value: unknown): ProductPrice {
  const none = { price: null, currency: null };
  if (typeof value !== "string") return none;
  const text = collapse(value);
  let amountText: string;
  let codeText: string;
  const amountFirst = /^(\d[\d.,]*)\s*([A-Za-z]{3})$/.exec(text);
  if (amountFirst) {
    [amountText, codeText] = [amountFirst[1], amountFirst[2]];
  } else {
    const codeFirst = /^([A-Za-z]{3})\s*(\d[\d.,]*)$/.exec(text);
    if (!codeFirst) return none;
    [codeText, amountText] = [codeFirst[1], codeFirst[2]];
  }
  // "1,234.50" → "1234.50"; "12,50" (decimal comma) → "12.50".
  const amount = amountText.includes(".") ? amountText.replace(/,/g, "") : amountText.replace(",", ".");
  const price = normalizePriceAmount(amount);
  const currency = normalizeCurrencyCode(codeText);
  return price && currency ? { price, currency } : none;
}

/** `g:availability`: true for "in stock" (any case, `_` or space), false for any other value, null when missing. */
export function parseFeedAvailability(value: unknown): boolean | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return value.trim().toLowerCase().replace(/[_\s]+/g, " ") === "in stock";
}

// ── Gate and records ─────────────────────────────────────────────────────────

interface GatedItem {
  item: FeedItem;
  externalId: string;
  title: string;
  brand: string;
  category: ProductCategory;
  /** Set for a `feed` or `retailer` source (title parsed with `parseRetailerTitle`). */
  listing?: RetailerTitle;
}

type GateOutcome = { accept: true; gated: GatedItem } | { accept: false; vendorless?: true };

/**
 * Whether a feed item is ingested: it needs an id and a title; a brand from `g:brand`, else
 * `settings.brand` (neither = skipped, counted as vendorless); the shared connector gate
 * (`classifyIngestedProduct` over the title, `g:product_type` and `g:color`, plus a textual
 * `g:google_product_category`); and no set word (gate evidence `set`, a title ending in one, or
 * a feed/retailer title `parseRetailerTitle` reads as a set).
 */
export function gateFeedItem(item: FeedItem, settings: SourceSettings): GateOutcome {
  const externalId = first(item, "id");
  const title = first(item, "title");
  if (!externalId || !title) return { accept: false };
  const brand = first(item, "brand") ?? settings.brand;
  if (!brand) return { accept: false, vendorless: true };

  const googleCategory = first(item, "google_product_category");
  const tags = [first(item, "color"), googleCategory && !/^\d+$/.test(googleCategory) ? googleCategory : null].filter(
    (tag): tag is string => Boolean(tag)
  );
  const gate = classifyIngestedProduct({ title, productType: first(item, "product_type"), tags });
  if (!gate.accept || gate.evidence === "set" || isRetailerSetSegment(title)) return { accept: false };

  if (settings.kind === "brand") {
    return { accept: true, gated: { item, externalId, title, brand, category: gate.category } };
  }
  const listing = parseRetailerTitle(title, brand);
  if (!listing || listing.isSet) return { accept: false };
  return { accept: true, gated: { item, externalId, title, brand, category: gate.category, listing } };
}

export interface FeedRecordResult {
  record: ConnectorProductRecord;
  /** The GTIN key when its check digit is wrong (kept on the record, reported in metadata). */
  invalidCheckDigit: string | null;
}

/** The connector record for an item `gateFeedItem` accepted. */
export function buildFeedRecord(gated: GatedItem, settings: SourceSettings): FeedRecordResult {
  const { item, externalId, title, brand, category, listing } = gated;
  const gtin = normalizeGtin(first(item, "gtin"));
  const productType = first(item, "product_type");
  const imageUrls = [...new Set([...all(item, "image_link").slice(0, 1), ...all(item, "additional_image_link")])];
  const { price, currency } = parseFeedPrice(first(item, "price"));
  // Atom entries may carry the description as <summary> or <content>.
  const description = first(item, "description") ?? first(item, "summary") ?? first(item, "content");
  return {
    invalidCheckDigit: gtin && !gtin.checkDigitValid ? gtin.gtin : null,
    record: {
      externalId,
      gtin: gtin?.gtin ?? null,
      raw: item,
      normalized: {
        productId: externalId,
        brand,
        name: listing ? listing.shadeName : title,
        rawTitle: title,
        productType,
        // Connector-gate category (#349); materialization re-classifies with the shade's finishes.
        productCategory: category,
        // A feed's attributes are not the brand's collection or finish tags; canonical finishes
        // come from descriptors and description text at materialization.
        tags: [],
        finishes: [],
        collections: [],
        descriptors: normalizeDescriptors([first(item, "color"), productType, first(item, "item_group_id")]),
        descriptionText: htmlToPlainText(description, PRODUCT_DESCRIPTION_MAX_CHARS),
        imageUrls,
        primaryImageUrl: imageUrls[0] ?? null,
        productUrl: first(item, "link"),
        price,
        currency,
        available: parseFeedAvailability(first(item, "availability")),
        kind: settings.kind,
        ...(listing
          ? { listingTitle: title, vendorCode: listing.vendorCode, productLine: listing.productLine }
          : {}),
      },
    },
  };
}

const SEARCH_TERMS_MEANING_ALL = new Set(["", "nail polish", "nail_polish", "nailpolish", "all", "*", "recent", "latest", "new"]);

/** The feed URL without its query string or credentials (for job metadata). */
function displayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split("?")[0];
  }
}

export interface ProductFeedConnectorOptions {
  /** Injected in tests; defaults to the global fetch. */
  fetchImpl?: FetchLike;
}

interface CachedFeed {
  format: FeedFormat;
  items: FeedItem[];
}

export class ProductFeedConnector implements ProductConnector {
  readonly source: SupportedConnectorSource;
  private readonly feedUrl: string;
  private readonly settings: SourceSettings;
  private readonly fetchImpl: FetchLike;
  private format: FeedFormat | null = null;

  constructor(
    source: SupportedConnectorSource,
    feedUrl: string,
    settings: SourceSettings,
    options: ProductFeedConnectorOptions = {}
  ) {
    this.source = source;
    this.feedUrl = feedUrl;
    this.settings = settings;
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  async pullProducts(options: ConnectorPullOptions): Promise<ConnectorPullResult> {
    // The cache holds items only; a cached run reports the format it parsed earlier, or null.
    const items = await loadCatalogWithCache<FeedItem>(options.catalogCache, async () => {
      const feed = await this.fetchFeed();
      this.format = feed.format;
      return feed.items;
    });

    const gated: GatedItem[] = [];
    let vendorlessSkipped = 0;
    for (const item of items) {
      const outcome = gateFeedItem(item, this.settings);
      if (outcome.accept) gated.push(outcome.gated);
      else if (outcome.vendorless) vendorlessSkipped += 1;
    }

    const term = options.searchTerm.trim().toLowerCase();
    const textFilter = SEARCH_TERMS_MEANING_ALL.has(term) ? null : term;
    const filtered = textFilter
      ? gated.filter(({ item, title, brand }) =>
          [title, brand, first(item, "product_type"), first(item, "color"), first(item, "item_group_id")].some(
            (value) => value?.toLowerCase().includes(textFilter)
          )
        )
      : gated;

    // Feed order is kept (a feed has no reliable timestamps); the page window is the only slice.
    const offset = Math.max(0, (options.page - 1) * options.pageSize);
    const windowed = filtered.slice(offset, offset + options.pageSize).slice(0, options.maxRecords);
    const built = windowed.map((entry) => buildFeedRecord(entry, this.settings));
    const invalidCheckDigits = built
      .filter((entry) => entry.invalidCheckDigit !== null)
      .map((entry) => ({ externalId: entry.record.externalId, gtin: entry.invalidCheckDigit as string }));

    return {
      source: this.source,
      records: built.map((entry) => entry.record),
      metadata: {
        requestUrl: displayUrl(this.feedUrl),
        responsePage: options.page,
        responsePageSize: options.pageSize,
        sourceCount: filtered.length,
        sourcePageCount: options.pageSize > 0 ? Math.ceil(filtered.length / options.pageSize) : null,
        fetchedProductCount: items.length,
        textFilter,
        connectorType: "product-feed",
        feedFormat: this.format,
        sourceKind: this.settings.kind,
        vendorlessSkipped,
        invalidCheckDigits,
      },
    };
  }

  /** Basic auth header from the env var `metadata.feedAuthEnv` names (`user:pass`), if set. */
  private authorizationHeader(): Record<string, string> {
    const envName = this.settings.feedAuthEnv;
    if (!envName) return {};
    const value = process.env[envName]?.trim();
    if (!value) {
      throw new Error(`${this.source}: metadata.feedAuthEnv names ${envName}, which is not set`);
    }
    return { Authorization: `Basic ${Buffer.from(value, "utf8").toString("base64")}` };
  }

  private async fetchFeed(): Promise<CachedFeed> {
    const headers = {
      Accept: "application/xml, text/xml, text/tab-separated-values, text/csv, text/plain;q=0.9, */*;q=0.5",
      "User-Agent": USER_AGENT,
      ...this.authorizationHeader(),
    };
    const shownUrl = displayUrl(this.feedUrl);
    const attemptCount = MAX_REQUEST_RETRIES + 1;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= attemptCount; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await this.fetchImpl(this.feedUrl, { method: "GET", headers, signal: controller.signal });
        if (!response.ok) {
          const error = new Error(`${this.source} feed request failed: ${response.status} ${response.statusText ?? ""}`.trim());
          if (attempt < attemptCount && isRetryableStatus(response.status)) {
            const backoffMs = RETRY_BASE_DELAY_MS * attempt;
            console.warn(`${this.source} feed retry ${attempt}/${MAX_REQUEST_RETRIES} after HTTP ${response.status}; waiting ${backoffMs}ms`, { url: shownUrl });
            await sleep(backoffMs);
            continue;
          }
          throw Object.assign(error, { noRetry: true });
        }
        const body = await response.text();
        const parsed = parseProductFeed(body, response.headers?.get("content-type"), this.feedUrl);
        if (parsed.items.length === 0) {
          throw Object.assign(new Error(`${this.source} feed has no items (${parsed.format})`), { noRetry: true });
        }
        return parsed;
      } catch (error) {
        let normalized = error instanceof Error ? error : new Error(String(error));
        if (normalized.name === "AbortError") {
          normalized = new Error(`${this.source} feed request timed out after ${REQUEST_TIMEOUT_MS}ms`);
        }
        const noRetry = (normalized as { noRetry?: boolean }).noRetry === true;
        if (!noRetry && attempt < attemptCount && isRetryableRequestError(normalized)) {
          const backoffMs = RETRY_BASE_DELAY_MS * attempt;
          console.warn(`${this.source} feed retry ${attempt}/${MAX_REQUEST_RETRIES} after error: ${normalized.message}; waiting ${backoffMs}ms`, { url: shownUrl });
          await sleep(backoffMs);
          continue;
        }
        lastError = normalized;
        break;
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError ?? new Error(`${this.source} feed request failed`);
  }
}
