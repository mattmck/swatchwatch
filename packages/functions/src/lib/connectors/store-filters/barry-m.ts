import { lowerTrim } from "./shared.js";
import type { StoreFilterProduct } from "./types.js";

/**
 * Barry M (barrym.com) product filter (brand sources plan, Task 11).
 *
 * Barry M is a UK cosmetics brand whose polish is "Nail Paint" ("Gelly Hi Shine Nail Paint |
 * Black Cherry"). The generic gate does not read "nail paint" as polish, so it drops shades without
 * a polish tag, and it keeps face and eye primers and lip treatments as coats and treatments. First
 * page on 2026-11-08: Nail Paint 106, Lip Liner 19, Glitter and Jewels 15, Lip Paint 14, Eyeliner
 * 9, Eyeshadow 8, Lip Treatment 7, Topcoat 5, Nail 5, Nail Care 4, Basecoat 1, Nail Product 1,
 * and other cosmetics types.
 *
 * - Kept: `Nail Paint`, `Basecoat`, `Topcoat` and any other type naming nails (`Nail`, `Nail
 *   Product`) or a base / top coat.
 * - `Nail Care` (the Mani Hero treatments) defers to the generic gate (null), which keeps
 *   treatments with their category.
 * - Dropped: nail art and nail tool types, and every cosmetics type.
 *
 * Fixture: tests/fixtures/barry-m-products.json (107 of the 250 first-page products, 2026-11-08).
 */

const NAIL_TYPE_REGEX = /\bnails?\b|\b(?:base|top)\s*coats?\b/i;
const DROPPED_NAIL_TYPE_REGEX = /\bnail\s+art\b|\btools?\b/i;
const CARE_TYPE = "nail care";

export function isBarryMPolish(product: StoreFilterProduct): boolean | null {
  const productType = lowerTrim(product.product_type);
  if (productType === CARE_TYPE) {
    return null;
  }
  return NAIL_TYPE_REGEX.test(productType) && !DROPPED_NAIL_TYPE_REGEX.test(productType);
}
