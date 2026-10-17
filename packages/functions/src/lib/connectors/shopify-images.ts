import type { ProductImageCandidate } from "../image-selection";

/** Subset of a Shopify `products.json` image object that ingestion keeps. */
export interface ShopifyProductImage {
  src?: string | null;
  alt?: string | null;
  position?: number | string | null;
  [key: string]: unknown;
}

/** Normalized image metadata stored on `normalized.images` by the Shopify connectors. */
export interface NormalizedShopifyImage extends ProductImageCandidate {
  url: string;
  alt: string | null;
  position: number | null;
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function cleanPosition(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function cleanUrl(value: unknown): string | null {
  const url = cleanText(value);
  if (!url) return null;
  return url.startsWith("//") ? `https:${url}` : url;
}

/**
 * Turn a Shopify `images` array (objects or bare `src` strings) into
 * `{ url, alt, position }` rows: blanks dropped, protocol-relative URLs made
 * absolute, duplicate URLs collapsed (first occurrence wins).
 */
export function normalizeShopifyImages(images: unknown): NormalizedShopifyImage[] {
  if (!Array.isArray(images)) return [];
  const seen = new Set<string>();
  const result: NormalizedShopifyImage[] = [];
  for (const entry of images) {
    let url: string | null = null;
    let alt: string | null = null;
    let position: number | null = null;
    if (typeof entry === "string") {
      url = cleanUrl(entry);
    } else if (entry && typeof entry === "object") {
      const row = entry as ShopifyProductImage;
      url = cleanUrl(row.src);
      alt = cleanText(row.alt);
      position = cleanPosition(row.position);
    }
    if (!url || seen.has(url)) continue;
    seen.add(url);
    result.push({ url, alt, position });
  }
  return result;
}
