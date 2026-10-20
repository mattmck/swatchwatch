import type { ManicurePolishRole } from "../types/manicure";

/**
 * What kind of product a shade is (#349, decision D23). Stored in `shade.product_category`
 * (CHECK-constrained, migration 20261019011858000_shade-product-category; a test keeps the two
 * lists equal). The classifier is `classifyProductCategory` in
 * `packages/functions/src/lib/product-category.ts`.
 *
 * - `color` — a color polish (the default).
 * - `topper` — glitter/flake/effect layered over another polish. Its finishes describe the
 *   particles; it has no meaningful single color.
 * - `top_coat`, `base_coat`, `treatment` — clear/functional products (sealers, base coats,
 *   strengtheners, cuticle oils).
 * - `accessory` — not a polish (tools, stamping plates, charms, magnets, ...). Never ingested;
 *   existing ones nobody holds are `status = 'excluded'`.
 */
export const PRODUCT_CATEGORIES = [
  "color",
  "topper",
  "top_coat",
  "base_coat",
  "treatment",
  "accessory",
] as const;

export type ProductCategory = (typeof PRODUCT_CATEGORIES)[number];

/** Who set a shade's category: the classifier (`rule`) or an admin (`admin`, never overwritten). */
export const PRODUCT_CATEGORY_SOURCES = ["rule", "admin"] as const;

export type ProductCategorySource = (typeof PRODUCT_CATEGORY_SOURCES)[number];

/** Short display labels. */
export const PRODUCT_CATEGORY_LABELS: Readonly<Record<ProductCategory, string>> = {
  color: "Color",
  topper: "Topper",
  top_coat: "Top coat",
  base_coat: "Base coat",
  treatment: "Treatment",
  accessory: "Accessory",
};

/** True when `value` is one of `PRODUCT_CATEGORIES` (exact, case-sensitive). */
export function isProductCategory(value: unknown): value is ProductCategory {
  return typeof value === "string" && (PRODUCT_CATEGORIES as readonly string[]).includes(value);
}

/**
 * A row's category, treating a missing or unknown value as `color` (responses from an API that
 * predates categories, or an un-migrated database).
 */
export function resolveProductCategory(value: unknown): ProductCategory {
  return isProductCategory(value) ? value : "color";
}

/** Coats and treatments: clear/functional products that count toward spend only (D-C). */
export function isCoatOrTreatment(category: unknown): boolean {
  const resolved = resolveProductCategory(category);
  return resolved === "top_coat" || resolved === "base_coat" || resolved === "treatment";
}

/**
 * Whether two shades can be dupes of each other (D-C): color vs color, topper vs topper. Coats,
 * treatments and accessories are never dupes, and color and topper never pair up. A missing
 * category counts as `color`.
 */
export function areDupeComparableCategories(a: unknown, b: unknown): boolean {
  const left = resolveProductCategory(a);
  const right = resolveProductCategory(b);
  if (left !== right) return false;
  return left === "color" || left === "topper";
}

/**
 * Default mani-log role for a polish of this category (D-C "mani log role prefill"): color →
 * `color`, topper and top coat → `topper` (the top layer), base coat and treatment → `base`.
 * Accessories have no role (null).
 */
export function manicureRoleForCategory(category: unknown): ManicurePolishRole | null {
  switch (resolveProductCategory(category)) {
    case "color":
      return "color";
    case "topper":
    case "top_coat":
      return "topper";
    case "base_coat":
    case "treatment":
      return "base";
    case "accessory":
      return null;
  }
}
