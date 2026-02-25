import {
  ConnectorPullOptions,
  ConnectorPullResult,
  ConnectorProductRecord,
  ProductConnector,
} from "./types";

const DEFAULT_BASE_URL = "https://makeup-api.herokuapp.com";
const REQUEST_TIMEOUT_MS = 15000;
const USER_AGENT = "SwatchWatch/connector-ingestion (+https://github.com/mattmck/swatchwatch)";

interface MakeupApiProduct {
  id?: number | string;
  brand?: string;
  name?: string;
  price?: string | null;
  price_sign?: string | null;
  currency?: string | null;
  image_link?: string | null;
  product_link?: string | null;
  website_link?: string | null;
  description?: string | null;
  rating?: number | string | null;
  category?: string | null;
  product_type?: string | null;
  product_api_url?: string | null;
  tag_list?: unknown;
  created_at?: string | null;
  updated_at?: string | null;
  product_colors?: Array<{ hex_value?: string | null; colour_name?: string | null }>;
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

function normalizeTagList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => asNonEmptyString(item))
    .filter((item): item is string => Boolean(item));
}

function normalizeColorVariants(value: unknown): Array<{ hex: string | null; name: string | null }> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((item) => {
    if (!item || typeof item !== "object") {
      return { hex: null, name: null };
    }

    const row = item as { hex_value?: unknown; colour_name?: unknown };
    return {
      hex: asNonEmptyString(row.hex_value),
      name: asNonEmptyString(row.colour_name),
    };
  });
}

function toNormalizedRecord(product: MakeupApiProduct): ConnectorProductRecord | null {
  const externalId = asNonEmptyString(product.id);
  if (!externalId) {
    return null;
  }

  const colorVariants = normalizeColorVariants(product.product_colors);
  const rating =
    typeof product.rating === "number"
      ? product.rating
      : typeof product.rating === "string"
        ? Number.parseFloat(product.rating)
        : null;

  return {
    externalId,
    gtin: null,
    raw: product as Record<string, unknown>,
    normalized: {
      source: "MakeupAPI",
      productId: externalId,
      brand: asNonEmptyString(product.brand),
      name: asNonEmptyString(product.name),
      productType: asNonEmptyString(product.product_type),
      category: asNonEmptyString(product.category),
      description: asNonEmptyString(product.description),
      price: asNonEmptyString(product.price),
      priceSign: asNonEmptyString(product.price_sign),
      currency: asNonEmptyString(product.currency),
      imageUrl: asNonEmptyString(product.image_link),
      productUrl: asNonEmptyString(product.product_link),
      websiteUrl: asNonEmptyString(product.website_link),
      productApiUrl: asNonEmptyString(product.product_api_url),
      rating: Number.isFinite(rating) ? rating : null,
      tags: normalizeTagList(product.tag_list),
      createdAt: asNonEmptyString(product.created_at),
      updatedAt: asNonEmptyString(product.updated_at),
      colorVariantCount: colorVariants.length,
      colorVariants,
    },
  };
}

function shouldApplyBrandFilter(searchTerm: string): boolean {
  const normalized = searchTerm.trim().toLowerCase();
  return !["", "nail polish", "nail_polish", "nailpolish", "all", "*"].includes(normalized);
}

export class MakeupApiConnector implements ProductConnector {
  readonly source = "MakeupAPI" as const;

  private readonly baseUrl: string;

  constructor(baseUrl?: string | null) {
    this.baseUrl = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  async pullProducts(options: ConnectorPullOptions): Promise<ConnectorPullResult> {
    const params = new URLSearchParams({ product_type: "nail_polish" });
    if (shouldApplyBrandFilter(options.searchTerm)) {
      params.set("brand", options.searchTerm.trim());
    }

    const endpoint = `${this.baseUrl}/api/v1/products.json?${params.toString()}`;
    const payload = await this.fetchJson(endpoint);
    if (!Array.isArray(payload)) {
      throw new Error("MakeupAPI response was not an array");
    }

    const allRecords = payload
      .map((entry) => (entry && typeof entry === "object" ? toNormalizedRecord(entry as MakeupApiProduct) : null))
      .filter((record): record is ConnectorProductRecord => Boolean(record));

    const offset = Math.max(0, (options.page - 1) * options.pageSize);
    const windowed = allRecords.slice(offset, offset + options.pageSize);
    const records = windowed.slice(0, options.maxRecords);

    return {
      source: this.source,
      records,
      metadata: {
        requestUrl: endpoint,
        responsePage: options.page,
        responsePageSize: options.pageSize,
        sourceCount: allRecords.length,
        sourcePageCount: options.pageSize > 0 ? Math.ceil(allRecords.length / options.pageSize) : null,
      },
    };
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
        throw new Error(`MakeupAPI request failed: ${response.status} ${response.statusText}`);
      }

      return response.json();
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("MakeupAPI request timed out");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
