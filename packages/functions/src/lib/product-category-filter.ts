import { isProductCategory, PRODUCT_CATEGORIES, type ProductCategory } from "swatchwatch-shared";

export type ProductCategoryFilterResult =
  | { ok: true; categories: ProductCategory[] }
  | { ok: false; error: string; invalid: string[] };

/** Spellings accepted in `?category=` besides the canonical names (`top-coat`, `topcoat`, ...). */
function normalizeCategory(value: string): string {
  const lower = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (lower === "topcoat") return "top_coat";
  if (lower === "basecoat") return "base_coat";
  if (lower === "toppers") return "topper";
  return lower;
}

/**
 * Parse the `category` query parameter shared by `GET /api/polishes` and
 * `GET /api/catalog/search` (#349): comma-separated and/or repeated, case-insensitive, `-` or a
 * space accepted for `_`. Returns the categories in `PRODUCT_CATEGORIES` order (stable cache
 * keys), an empty list when absent, or an error naming the unknown values.
 */
export function parseProductCategoryFilter(searchParams: URLSearchParams): ProductCategoryFilterResult {
  const requested = new Set<ProductCategory>();
  const invalid: string[] = [];
  for (const raw of searchParams.getAll("category")) {
    for (const part of raw.split(",")) {
      if (!part.trim()) continue;
      const value = normalizeCategory(part);
      if (isProductCategory(value)) {
        requested.add(value);
      } else {
        invalid.push(part.trim());
      }
    }
  }
  if (invalid.length > 0) {
    return {
      ok: false,
      invalid,
      error: `Invalid product category: ${invalid.join(", ")}. Valid categories: ${PRODUCT_CATEGORIES.join(", ")}`,
    };
  }
  return { ok: true, categories: PRODUCT_CATEGORIES.filter((category) => requested.has(category)) };
}
