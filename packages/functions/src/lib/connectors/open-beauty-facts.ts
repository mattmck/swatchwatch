import {
  ConnectorPullOptions,
  ConnectorPullResult,
  ConnectorProductRecord,
  ProductConnector,
} from "./types";

const DEFAULT_BASE_URL = "https://world.openbeautyfacts.org";
const REQUEST_TIMEOUT_MS = 15000;
const USER_AGENT = "SwatchWatch/connector-ingestion (+https://github.com/mattmck/swatchwatch)";

function asNonEmptyString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
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
    .map((item) => asNonEmptyString(item))
    .filter((item): item is string => Boolean(item));
}

function normalizeProduct(product: Record<string, unknown>): ConnectorProductRecord | null {
  const gtin = asNonEmptyString(product.code);
  if (!gtin) {
    return null;
  }

  const name =
    asNonEmptyString(product.product_name) ||
    asNonEmptyString(product.generic_name) ||
    asNonEmptyString(product.abbreviated_product_name);
  const brand = asNonEmptyString(product.brands);
  const ingredientsText = asNonEmptyString(product.ingredients_text);
  const categoriesTags = asStringArray(product.categories_tags);
  const imageUrl = asNonEmptyString(product.image_url) || asNonEmptyString(product.image_front_url);
  const lastModifiedEpoch =
    typeof product.last_modified_t === "number" ? product.last_modified_t : null;

  return {
    externalId: gtin,
    gtin,
    raw: product,
    normalized: {
      source: "OpenBeautyFacts",
      gtin,
      name,
      brand,
      ingredientsText,
      categoriesTags,
      imageUrl,
      lastModifiedAt: lastModifiedEpoch
        ? new Date(lastModifiedEpoch * 1000).toISOString()
        : null,
    },
  };
}

export class OpenBeautyFactsConnector implements ProductConnector {
  readonly source = "OpenBeautyFacts" as const;

  private readonly baseUrl: string;

  constructor(baseUrl?: string | null) {
    this.baseUrl = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  async pullProducts(options: ConnectorPullOptions): Promise<ConnectorPullResult> {
    const params = new URLSearchParams({
      search_terms: options.searchTerm,
      search_simple: "1",
      action: "process",
      json: "1",
      page: String(options.page),
      page_size: String(options.pageSize),
    });

    const endpoint = `${this.baseUrl}/cgi/search.pl?${params.toString()}`;
    const payload = await this.fetchJson(endpoint);

    const root =
      payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
    if (!root || !Array.isArray(root.products)) {
      throw new Error("OpenBeautyFacts search response missing products array");
    }

    const records: ConnectorProductRecord[] = [];
    for (const candidate of root.products) {
      if (records.length >= options.maxRecords) {
        break;
      }

      if (!candidate || typeof candidate !== "object") {
        continue;
      }

      const normalized = normalizeProduct(candidate as Record<string, unknown>);
      if (!normalized) {
        continue;
      }

      records.push(normalized);
    }

    const totalAvailable =
      typeof root.count === "number"
        ? root.count
        : typeof root.count === "string"
          ? parseInt(root.count, 10)
          : null;
    const pageCount =
      typeof root.page_count === "number"
        ? root.page_count
        : typeof root.page_count === "string"
          ? parseInt(root.page_count, 10)
          : null;

    return {
      source: this.source,
      records,
      metadata: {
        requestUrl: endpoint,
        responsePage: options.page,
        responsePageSize: options.pageSize,
        sourceCount: Number.isFinite(totalAvailable) ? totalAvailable : null,
        sourcePageCount: Number.isFinite(pageCount) ? pageCount : null,
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
        throw new Error(`OpenBeautyFacts request failed: ${response.status} ${response.statusText}`);
      }

      return response.json();
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("OpenBeautyFacts request timed out");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
