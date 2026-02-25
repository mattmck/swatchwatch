import {
  ConnectorPullOptions,
  ConnectorPullResult,
  ConnectorProductRecord,
  ProductConnector,
} from "./types";

const DEFAULT_BASE_URL = "https://www.holotaco.com";
const REQUEST_TIMEOUT_MS = 20000;
const USER_AGENT = "SwatchWatch/connector-ingestion (+https://github.com/mattmck/swatchwatch)";
const SHOPIFY_PAGE_LIMIT = 250;
const MAX_SHOPIFY_PAGES = 30;
const DEFAULT_RECENT_DAYS = 120;

interface ShopifyVariant {
  id?: number | string;
  title?: string | null;
  sku?: string | null;
  barcode?: string | null;
  price?: string | number | null;
  compare_at_price?: string | number | null;
  available?: boolean;
  option1?: string | null;
  option2?: string | null;
  option3?: string | null;
}

interface ShopifyProductImage {
  src?: string | null;
}

interface ShopifyProduct {
  id?: number | string;
  title?: string | null;
  handle?: string | null;
  vendor?: string | null;
  product_type?: string | null;
  tags?: string | string[] | null;
  variants?: ShopifyVariant[] | null;
  images?: Array<ShopifyProductImage | string> | null;
  created_at?: string | null;
  updated_at?: string | null;
  published_at?: string | null;
  [key: string]: unknown;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value === "string") {
    const normalized = value.replace(/\s+/g, " ").trim();
    return normalized.length > 0 ? normalized : null;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  return null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => asNonEmptyString(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function normalizeTags(tags: unknown): string[] {
  if (typeof tags === "string") {
    return tags
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return asStringArray(tags);
}

function normalizeImageUrls(images: unknown): string[] {
  if (!Array.isArray(images)) {
    return [];
  }

  const urls = images
    .map((image) => {
      if (typeof image === "string") {
        return asNonEmptyString(image);
      }
      if (!image || typeof image !== "object") {
        return null;
      }
      const row = image as ShopifyProductImage;
      return asNonEmptyString(row.src);
    })
    .filter((url): url is string => Boolean(url));

  return Array.from(
    new Set(
      urls.map((url) => {
        if (url.startsWith("//")) {
          return `https:${url}`;
        }
        return url;
      })
    )
  );
}

function normalizeVariants(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: Array<Record<string, unknown>> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const variant = entry as ShopifyVariant;
    normalized.push({
      id: asNonEmptyString(variant.id),
      title: asNonEmptyString(variant.title),
      sku: asNonEmptyString(variant.sku),
      barcode: asNonEmptyString(variant.barcode),
      price: asNonEmptyString(variant.price),
      compareAtPrice: asNonEmptyString(variant.compare_at_price),
      available: typeof variant.available === "boolean" ? variant.available : null,
      option1: asNonEmptyString(variant.option1),
      option2: asNonEmptyString(variant.option2),
      option3: asNonEmptyString(variant.option3),
    });
  }
  return normalized;
}

function extractTaggedValues(tags: string[], prefix: string): string[] {
  const lowerPrefix = prefix.toLowerCase();
  return tags
    .filter((tag) => tag.toLowerCase().startsWith(lowerPrefix))
    .map((tag) => tag.slice(prefix.length).trim())
    .filter(Boolean);
}

function isNailPolish(productType: string | null, tags: string[]): boolean {
  if (productType && productType.toLowerCase() === "nail polish") {
    return true;
  }
  return tags.some((tag) => tag.toLowerCase() === "nail-polish");
}

function isBundle(tags: string[]): boolean {
  const normalized = tags.map((tag) => tag.toLowerCase());
  return normalized.includes("bundle:product") || normalized.includes("product-bundle");
}

function shouldApplyTextFilter(searchTerm: string): boolean {
  const normalized = searchTerm.trim().toLowerCase();
  return !["", "nail polish", "nail_polish", "nailpolish", "all", "*", "recent", "latest", "new"].includes(normalized);
}

function resolveRecentDays(searchTerm: string, recentDays?: number): number | undefined {
  if (typeof recentDays === "number" && Number.isFinite(recentDays) && recentDays > 0) {
    return recentDays;
  }

  const normalized = searchTerm.trim().toLowerCase();
  if (["recent", "latest", "new"].includes(normalized)) {
    return DEFAULT_RECENT_DAYS;
  }

  return undefined;
}

function toTimestamp(value: unknown): number {
  const text = asNonEmptyString(value);
  if (!text) {
    return 0;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function recordTimestamp(record: ConnectorProductRecord): number {
  const normalized =
    record.normalized && typeof record.normalized === "object"
      ? (record.normalized as Record<string, unknown>)
      : {};
  return Math.max(
    toTimestamp(normalized.publishedAt),
    toTimestamp(normalized.createdAt),
    toTimestamp(normalized.updatedAt)
  );
}

function toNormalizedRecord(
  product: ShopifyProduct,
  baseUrl: string
): ConnectorProductRecord | null {
  const externalId = asNonEmptyString(product.id);
  if (!externalId) {
    return null;
  }

  const tags = normalizeTags(product.tags);
  const productType = asNonEmptyString(product.product_type);
  if (!isNailPolish(productType, tags) || isBundle(tags)) {
    return null;
  }

  const name = asNonEmptyString(product.title);
  if (!name) {
    return null;
  }

  const handle = asNonEmptyString(product.handle);
  const brand = asNonEmptyString(product.vendor) || "Holo Taco";
  const collections = extractTaggedValues(tags, "collection:");
  const finishes = extractTaggedValues(tags, "finish:");
  const imageUrls = normalizeImageUrls(product.images);
  const variants = normalizeVariants(product.variants);
  const gtin =
    variants
      .map((variant) => asNonEmptyString(variant.barcode))
      .find((barcode): barcode is string => Boolean(barcode)) || null;

  return {
    externalId,
    gtin,
    raw: product as Record<string, unknown>,
    normalized: {
      source: "HoloTacoShopify",
      productId: externalId,
      brand,
      name,
      handle,
      productType,
      collections,
      finishes,
      tags,
      imageUrls,
      primaryImageUrl: imageUrls[0] || null,
      productUrl: handle ? `${baseUrl}/products/${handle}` : null,
      variants,
      vendorHex: null,
      nameHex: null,
      createdAt: asNonEmptyString(product.created_at),
      updatedAt: asNonEmptyString(product.updated_at),
      publishedAt: asNonEmptyString(product.published_at),
    },
  };
}

export class HoloTacoShopifyConnector implements ProductConnector {
  readonly source = "HoloTacoShopify" as const;

  private readonly baseUrl: string;

  constructor(baseUrl?: string | null) {
    this.baseUrl = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  async pullProducts(options: ConnectorPullOptions): Promise<ConnectorPullResult> {
    const allProducts = await this.fetchAllProducts();
    const normalizedRecords = allProducts
      .map((product) => toNormalizedRecord(product, this.baseUrl))
      .filter((record): record is ConnectorProductRecord => Boolean(record));

    const textFilter = shouldApplyTextFilter(options.searchTerm)
      ? options.searchTerm.trim().toLowerCase()
      : null;
    const recentDays = resolveRecentDays(options.searchTerm, options.recentDays);
    const cutoffEpoch = recentDays ? Date.now() - recentDays * 24 * 60 * 60 * 1000 : null;

    let filteredRecords = normalizedRecords;
    if (textFilter) {
      filteredRecords = filteredRecords.filter((record) => {
        const normalized =
          record.normalized && typeof record.normalized === "object"
            ? (record.normalized as Record<string, unknown>)
            : {};
        const values = [
          asNonEmptyString(normalized.name),
          asNonEmptyString(normalized.brand),
          asNonEmptyString(normalized.handle),
          ...asStringArray(normalized.tags),
          ...asStringArray(normalized.collections),
          ...asStringArray(normalized.finishes),
        ].filter((entry): entry is string => Boolean(entry));
        return values.some((entry) => entry.toLowerCase().includes(textFilter));
      });
    }

    if (cutoffEpoch !== null) {
      filteredRecords = filteredRecords.filter((record) => recordTimestamp(record) >= cutoffEpoch);
    }

    filteredRecords.sort((a, b) => recordTimestamp(b) - recordTimestamp(a));

    const offset = Math.max(0, (options.page - 1) * options.pageSize);
    const windowed = filteredRecords.slice(offset, offset + options.pageSize);
    const records = windowed.slice(0, options.maxRecords);

    return {
      source: this.source,
      records,
      metadata: {
        requestUrl: `${this.baseUrl}/products.json`,
        responsePage: options.page,
        responsePageSize: options.pageSize,
        sourceCount: filteredRecords.length,
        sourcePageCount: options.pageSize > 0 ? Math.ceil(filteredRecords.length / options.pageSize) : null,
        fetchedProductCount: allProducts.length,
        recentDays: recentDays || null,
        textFilter: textFilter || null,
      },
    };
  }

  private async fetchAllProducts(): Promise<ShopifyProduct[]> {
    const allProducts: ShopifyProduct[] = [];

    for (let page = 1; page <= MAX_SHOPIFY_PAGES; page += 1) {
      const params = new URLSearchParams({
        limit: String(SHOPIFY_PAGE_LIMIT),
        page: String(page),
      });
      const endpoint = `${this.baseUrl}/products.json?${params.toString()}`;
      const payload = await this.fetchJson(endpoint);

      const root =
        payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
      if (!root || !Array.isArray(root.products)) {
        throw new Error("HoloTacoShopify response missing products array");
      }

      const pageProducts = root.products
        .filter((entry) => entry && typeof entry === "object")
        .map((entry) => entry as ShopifyProduct);
      allProducts.push(...pageProducts);

      if (pageProducts.length < SHOPIFY_PAGE_LIMIT) {
        break;
      }
    }

    return allProducts;
  }

  private async fetchJson(url: string): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "User-Agent": USER_AGENT,
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HoloTacoShopify request failed: ${response.status} ${response.statusText}`);
      }

      return response.json();
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("HoloTacoShopify request timed out");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
