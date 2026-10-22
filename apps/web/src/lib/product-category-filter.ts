import { PRODUCT_CATEGORIES, isProductCategory, type ProductCategory } from "swatchwatch-shared";

/**
 * Parse the `/polishes?category=` URL value (comma-separated) into categories in canonical
 * `PRODUCT_CATEGORIES` order (#349). Unknown values are dropped (the API answers 400 for them).
 */
export function parseProductCategoryParam(value: string | null | undefined): ProductCategory[] {
  if (!value) return [];
  const requested = new Set<string>(
    value
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .filter(isProductCategory)
  );
  return PRODUCT_CATEGORIES.filter((category) => requested.has(category));
}

/** Add or remove `category`, keeping canonical order. */
export function toggleProductCategory(
  categories: readonly ProductCategory[],
  category: ProductCategory
): ProductCategory[] {
  const next = new Set(categories);
  if (next.has(category)) next.delete(category);
  else next.add(category);
  return PRODUCT_CATEGORIES.filter((candidate) => next.has(candidate));
}
