import { lowerTrim } from "./shared.js";
import type { StoreFilterProduct } from "./types.js";

/**
 * CND (cnd.com) product filter (brand sources plan, Task 11).
 *
 * CND's products.json (117 products on 2026-11-08) has an empty `product_type` on everything but
 * the six `Gel Polish` listings, which are Shellac families ("CND™ SHELLAC™ Gel Nail Polish -
 * Reds") carrying each family's 21–35 shades as variants. The rest is Vinylux collections and
 * coats, lacquer treatments, Plexigel / Brisa / liquid-and-powder enhancement systems, tools, lamps
 * and skincare; no single Vinylux shade is on page 1. The connector stores one record per product,
 * so a family listing is never a shade.
 *
 * - Dropped first, by title: kits, collections, sets, systems, brushes, lamps, tips, files and
 *   buffers, wraps, removers, hand wash, lotion, scrubs, skincare, the Vinylux and Shellac line
 *   listings ("VINYLUX™ Long Wear Polish", "CND™ SHELLAC™ Brand", "… Color Coat"), and the
 *   enhancement systems (Plexigel, Brisa, sculpting, liquid & powder, Retention+, Liquid Bond,
 *   SealeBond, color powders, additives).
 * - Shellac (title, or the `Gel Polish` type): a base or top coat title is kept only when the
 *   source's `includeGel` is true; family listings are always dropped.
 * - Kept: any other title naming Vinylux (lacquer), and base or top coat titles.
 * - Everything else defers to the generic gate (null), which keeps the lacquer treatments CND
 *   tags `Treatments` (Solaroil, RidgeFx, Stickey, Super Shiney, …).
 *
 * Fixture: tests/fixtures/cnd-products.json (all 117 products, 2026-11-08).
 */

const NON_POLISH_TITLE_REGEX = new RegExp(
  "\\b(?:" +
    [
      "kits?",
      "collections?",
      "sets?",
      "systems?",
      "brush(?:es)?",
      "lamps?",
      "tips",
      "files?",
      "buffers?",
      "wraps",
      "removers?",
      "hand\\s+wash",
      "lotions?",
      "scrubs?",
      "skincare",
      "long\\s+wear\\s+polish$",
      "brand$",
      "color\\s+coat$",
      "plexigel",
      "brisa",
      "sculpting",
      "liquid\\s*&\\s*powder",
      "retention\\+",
      "liquid\\s+bond",
      "sealebond",
      "colou?r\\s+powders?",
      "additives",
    ].join("|") +
    ")(?![a-z0-9])",
  "i"
);
const SHELLAC_REGEX = /\bshellac\b/i;
const VINYLUX_REGEX = /\bvinylux\b/i;
const COAT_TITLE_REGEX = /\b(?:base|top)\s*coats?\b/i;
const GEL_TYPE = "gel polish";

/** The title with trademark signs dropped, so "VINYLUX™" and "SHELLAC™" read as words. */
function plainTitle(value: unknown): string {
  return typeof value === "string" ? value.replace(/[™®©]/g, "").replace(/\s+/g, " ").trim() : "";
}

/** Store filter for CND (CndShopify): `true` keeps the product, `false` drops it, `null` defers to the generic polish gate. */
export function isCndPolish(
  product: StoreFilterProduct,
  settings: { includeGel: boolean } = { includeGel: false }
): boolean | null {
  const title = plainTitle(product.title);
  if (NON_POLISH_TITLE_REGEX.test(title)) {
    return false;
  }
  const isCoat = COAT_TITLE_REGEX.test(title);
  if (SHELLAC_REGEX.test(title) || lowerTrim(product.product_type) === GEL_TYPE) {
    return settings.includeGel && isCoat;
  }
  if (VINYLUX_REGEX.test(title) || isCoat) {
    return true;
  }
  return null;
}
