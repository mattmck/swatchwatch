/**
 * Generic Shopify Connector
 * 
 * Fetches products from any Shopify store's products.json endpoint.
 * Extracts hex colors from variant options, tags, and uses AI fallback
 * for color name → hex mapping when no hex is available.
 */

import type { SupportedConnectorSource } from "./types.js";
import {
  ConnectorPullOptions,
  ConnectorPullResult,
  ConnectorProductRecord,
  ProductConnector,
} from "./types.js";
import { detectHexFromColorName } from "./color-name-detection.js";

const REQUEST_TIMEOUT_MS = 20000;
const USER_AGENT = "SwatchWatch/connector-ingestion (+https://github.com/mattmck/swatchwatch)";
const SHOPIFY_PAGE_LIMIT = 250;
const MAX_SHOPIFY_PAGES = 30;
const DEFAULT_RECENT_DAYS = 120;

// Regex to extract hex color from option values like "#FF6B6B" or "FF6B6B"
const HEX_COLOR_REGEX = /#?([0-9A-Fa-f]{6})/;

// Shopify product interface (generic)
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

/**
 * Extract hex color from a Shopify variant option value
 * Looks for patterns like "#FF6B6B" or "FF6B6B"
 */
function extractHexFromOption(optionValue: string | null): string | null {
  if (!optionValue) {
    return null;
  }

  const match = optionValue.match(HEX_COLOR_REGEX);
  if (match) {
    const hex = match[1].toUpperCase();
    return `#${hex}`;
  }

  return null;
}

/**
 * Extract color hex from variant options (option1, option2, option3)
 * and also from the product title
 */
function extractHexFromProduct(product: ShopifyProduct): string | null {
  // Check variant options first
  if (product.variants && Array.isArray(product.variants)) {
    for (const variant of product.variants) {
      const variantHex =
        extractHexFromOption(variant.option1 ?? null) ||
        extractHexFromOption(variant.option2 ?? null) ||
        extractHexFromOption(variant.option3 ?? null);
      if (variantHex) {
        return variantHex;
      }
    }
  }

  // Fallback: check product title
  const titleHex = extractHexFromOption(product.title || null);
  if (titleHex) {
    return titleHex;
  }

  return null;
}

/**
 * Extract color name from variant options when no hex is available
 */
function extractColorNameFromProduct(product: ShopifyProduct): string | null {
  // Try variant options first
  if (product.variants && Array.isArray(product.variants)) {
    for (const variant of product.variants) {
      // Skip if it looks like a hex value
      const option1 = variant.option1;
      if (option1 && !option1.match(HEX_COLOR_REGEX)) {
        return asNonEmptyString(option1);
      }
      const option2 = variant.option2;
      if (option2 && !option2.match(HEX_COLOR_REGEX)) {
        return asNonEmptyString(option2);
      }
    }
  }

  // Fallback to title (strip hex if present)
  const title = asNonEmptyString(product.title);
  if (title) {
    // Remove hex patterns from title to get color name
    const cleanTitle = title.replace(HEX_COLOR_REGEX, "").trim();
    if (cleanTitle.length > 0) {
      return cleanTitle;
    }
  }

  return null;
}

/**
 * Extract finish/type from tags (common patterns: finish:, type:, collection:)
 */
function extractFinishFromTags(tags: string[]): string[] {
  const finishes: string[] = [];
  const prefixes = ["finish:", "type:", "collection:"];

  for (const tag of tags) {
    const lowerTag = tag.toLowerCase();
    for (const prefix of prefixes) {
      if (lowerTag.startsWith(prefix)) {
        const value = tag.slice(prefix.length).trim();
        if (value) {
          finishes.push(value);
        }
      }
    }
  }

  return finishes;
}

/**
 * Extract color from tags (pattern: color:)
 */
function extractColorFromTags(tags: string[]): string[] {
  const colors: string[] = [];
  const prefix = "color:";

  for (const tag of tags) {
    const lowerTag = tag.toLowerCase();
    if (lowerTag.startsWith(prefix)) {
      const value = tag.slice(prefix.length).trim();
      if (value) {
        colors.push(value);
      }
    }
  }

  return colors;
}

function extractTaggedValues(tags: string[], prefix: string): string[] {
  const lowerPrefix = prefix.toLowerCase();
  return tags
    .filter((tag) => tag.toLowerCase().startsWith(lowerPrefix))
    .map((tag) => tag.slice(prefix.length).trim())
    .filter(Boolean);
}

function isNailPolish(productType: string | null, tags: string[]): boolean {
  if (productType && productType.toLowerCase().includes("nail")) {
    return true;
  }
  const normalizedTags = tags.map((t) => t.toLowerCase());
  return normalizedTags.some(
    (tag) =>
      tag.includes("nail") ||
      tag.includes("polish") ||
      tag.includes("lacquer") ||
      tag.includes("gel")
  );
}

function isBundle(tags: string[]): boolean {
  const normalized = tags.map((tag) => tag.toLowerCase());
  return (
    normalized.includes("bundle:product") ||
    normalized.includes("product-bundle") ||
    normalized.includes("bundle")
  );
}

function shouldApplyTextFilter(searchTerm: string): boolean {
  const normalized = searchTerm.trim().toLowerCase();
  return ![
    "",
    "nail polish",
    "nail_polish",
    "nailpolish",
    "all",
    "*",
    "recent",
    "latest",
    "new",
  ].includes(normalized);
}

function resolveRecentDays(
  searchTerm: string,
  recentDays?: number
): number | undefined {
  if (
    typeof recentDays === "number" &&
    Number.isFinite(recentDays) &&
    recentDays > 0
  ) {
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

export class ShopifyGenericConnector implements ProductConnector {
  readonly source: SupportedConnectorSource;

  private readonly baseUrl: string;
  private readonly brandName: string;

  constructor(source: SupportedConnectorSource, baseUrl?: string | null) {
    this.source = source;
    // Extract brand name from source (e.g., "MooncatShopify" -> "Mooncat")
    this.brandName = source.replace(/Shopify$/, "").replace(/([A-Z])/g, " $1").trim();
    this.baseUrl = (baseUrl || this.defaultBaseUrl()).replace(/\/+$/, "");
  }

  private defaultBaseUrl(): string {
    // Map known sources to their URLs
    const urlMap: Record<string, string> = {
      MooncatShopify: "https://www.mooncat.com",
      ClionadhShopify: "https://clionadhcosmetics.com",
      OrlyShopify: "https://orlybeauty.com",
      BeesKneesLacquerShopify: "https://www.beeskneeslacquer.com",
      GreatLakesLacquerShopify: "https://www.greatlakeslacquer.com",
      RoylaleeShopify: "https://roylalee.com",
      GardenPathLacquersShopify: "https://gardenpathlacquers.com",
      KathleenAndCoShopify: "https://kathleenandco.com",
      PrismParadeShopify: "https://prismparade.com",
      SassysaucePolishShopify: "https://sassysaucepolish.com",
      ColorClubShopify: "https://colorclub.com",
      RogueLacquerShopify: "https://roguelacquer.com",
      RedEyedLacquerShopify: "https://redeyedlacquer.com",
      CupcakePolishShopify: "https://www.cupcakepolish.com",
      LoudBabbsShopify: "https://loudbabbs.com",
      PaintItPrettyPolishShopify: "https://paintitprettypolish.com",
      ChinaGlazeShopify: "https://chinaglaze.com",
      LeMiniMacaronShopify: "https://www.leminimacaron.eu",
      CrackedPolishShopify: "https://crackedpolish.com",
      OliveAvePolishShopify: "https://oliveavepolish.com",
      LightsLacquerShopify: "https://lightslacquer.com",
      ZombieClawPolishShopify: "https://zombieclawpolish.com",
      PotionPolishShopify: "https://www.potionpolish.com",
      StarrilyShopify: "https://www.starrily.com",
      TylerStrinketsShopify: "https://tylerstrinkets.com",
      DrunkFairyPolishShopify: "https://drunkfairypolish.com",
      HoloTacoShopify: "https://www.holotaco.com",
    };

    return urlMap[this.source] || `https://${this.source.replace(/Shopify$/, "").toLowerCase().replace(/ /g, "")}.com`;
  }

  async pullProducts(options: ConnectorPullOptions): Promise<ConnectorPullResult> {
    const allProducts = await this.fetchAllProducts();
    const normalizedRecords = await Promise.all(
      allProducts.map((product) => toNormalizedRecord(product, this.baseUrl, this.brandName))
    );
    const filteredRecords = normalizedRecords.filter(
      (record): record is ConnectorProductRecord => Boolean(record)
    );

    const textFilter = shouldApplyTextFilter(options.searchTerm)
      ? options.searchTerm.trim().toLowerCase()
      : null;
    const recentDays = resolveRecentDays(options.searchTerm, options.recentDays);
    const cutoffEpoch = recentDays
      ? Date.now() - recentDays * 24 * 60 * 60 * 1000
      : null;

    let filtered = filteredRecords;
    if (textFilter) {
      filtered = filtered.filter((record) => {
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
      filtered = filtered.filter((record) => recordTimestamp(record) >= cutoffEpoch);
    }

    filtered.sort((a, b) => recordTimestamp(b) - recordTimestamp(a));

    const offset = Math.max(0, (options.page - 1) * options.pageSize);
    const windowed = filtered.slice(offset, offset + options.pageSize);
    const records = windowed.slice(0, options.maxRecords);

    return {
      source: this.source as any,
      records,
      metadata: {
        requestUrl: `${this.baseUrl}/products.json`,
        responsePage: options.page,
        responsePageSize: options.pageSize,
        sourceCount: filtered.length,
        sourcePageCount:
          options.pageSize > 0
            ? Math.ceil(filtered.length / options.pageSize)
            : null,
        fetchedProductCount: allProducts.length,
        recentDays: recentDays || null,
        textFilter: textFilter || null,
        connectorType: "generic-shopify",
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
        payload && typeof payload === "object"
          ? (payload as Record<string, unknown>)
          : null;
      if (!root || !Array.isArray(root.products)) {
        throw new Error(`${this.source} response missing products array`);
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
        throw new Error(
          `${this.source} request failed: ${response.status} ${response.statusText}`
        );
      }

      return response.json();
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`${this.source} request timed out`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function toNormalizedRecord(
  product: ShopifyProduct,
  baseUrl: string,
  brandName: string
): Promise<ConnectorProductRecord | null> {
  const externalId = asNonEmptyString(product.id);
  if (!externalId) {
    return null;
  }

  const tags = normalizeTags(product.tags);
  const productType = asNonEmptyString(product.product_type);

  // Skip non-nail products
  if (!isNailPolish(productType, tags) || isBundle(tags)) {
    return null;
  }

  const name = asNonEmptyString(product.title);
  if (!name) {
    return null;
  }

  const handle = asNonEmptyString(product.handle);
  const vendor = asNonEmptyString(product.vendor) || brandName;
  const collections = extractTaggedValues(tags, "collection:");
  const finishes = extractFinishFromTags(tags);
  const tagColors = extractColorFromTags(tags);
  const imageUrls = normalizeImageUrls(product.images);
  const variants = normalizeVariants(product.variants);

  // Extract hex from options
  let hex = extractHexFromProduct(product);
  let colorName: string | null = null;
  let detectedHex: string | null = null;
  let hexSource: string | null = null;

  // If no hex found in options, try color name detection
  // AI takes precedence over builtin lookup for better color accuracy
  if (!hex) {
    colorName = extractColorNameFromProduct(product);
    if (colorName) {
      // Try AI first for better nail polish color accuracy
      const aiResult = await detectHexFromColorName(colorName, { preferAi: true });
      if (aiResult.hex) {
        detectedHex = aiResult.hex;
        hexSource = aiResult.provider === "azure-openai" ? "ai-lookup" : "builtin-lookup";
      }
    }
  } else {
    hexSource = "variant-option";
  }

  const gtin = variants
    .map((variant) => asNonEmptyString(variant.barcode))
    .find((barcode): barcode is string => Boolean(barcode)) || null;

  return {
    externalId,
    gtin,
    raw: product as Record<string, unknown>,
    normalized: {
      source: product.title, // Will be set by connector
      productId: externalId,
      brand: vendor,
      name,
      handle,
      productType,
      collections,
      finishes,
      tags,
      tagColors,
      imageUrls,
      primaryImageUrl: imageUrls[0] || null,
      productUrl: handle ? `${baseUrl}/products/${handle}` : null,
      variants,
      // Color data - always store both the color name and detected hex
      colorName: colorName || null,
      hex: hex || detectedHex,
      detectedHex: detectedHex,
      hexSource,
      createdAt: asNonEmptyString(product.created_at),
      updatedAt: asNonEmptyString(product.updated_at),
      publishedAt: asNonEmptyString(product.published_at),
    },
  };
}
