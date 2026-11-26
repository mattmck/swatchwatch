import { isRetailerSetSegment } from "../retailer-title.js";
import type { StoreFilterProduct } from "./types.js";

/**
 * Beyond Polish (beyondpolish.com) product filter.
 *
 * Beyond Polish is a US multi-brand retailer (metadata.kind = "retailer", 103 vendors, 17,508
 * products on 2026-11-08). Its `product_type` separates the lacquer lines we want from gel,
 * combos, hair, skin, jewellery, tools and sets:
 *
 * - Accepted: `Nail Lacquer`, `Lacquer & Dip`, `Gel, Lacquer & Dip`; and `Gel Polish` when the
 *   source's `includeGel` setting is true.
 * - Dropped: `Gel & Lacquer Polish` (every product is a combo), every other product type, the
 *   store's own merchandise (vendor "Beyond Polish"), any product tagged Nail Set, TIER COMBO,
 *   Custom Bundle, Kit or Mystery Box (a random item, not a shade), and set, collection and combo titles (a set word ending a title
 *   segment, as the retailer title parser reads it).
 *
 * The retailer gate then resolves the vendor to a brand and parses the title.
 *
 * Fixture: tests/fixtures/beyond-polish-pull-products.json (247 of 17,508 products, 2026-11-08).
 */

const LACQUER_TYPES: ReadonlySet<string> = new Set(["nail lacquer", "lacquer & dip", "gel, lacquer & dip"]);
const GEL_TYPE = "gel polish";
const SET_TAGS: ReadonlySet<string> = new Set(["nail set", "tier combo", "custom bundle", "kit", "mystery box"]);
const STORE_VENDOR = "beyond polish";

function lowerTrim(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** Shopify's tags as a list: an array, or the comma-separated string of products.json. */
function tagList(tags: unknown): string[] {
  if (Array.isArray(tags)) return tags.map(lowerTrim).filter(Boolean);
  if (typeof tags === "string") return tags.split(",").map(lowerTrim).filter(Boolean);
  return [];
}

export function isBeyondPolishPolish(
  product: StoreFilterProduct,
  settings: { includeGel: boolean } = { includeGel: false }
): boolean {
  if (lowerTrim(product.vendor) === STORE_VENDOR) {
    return false;
  }
  const productType = lowerTrim(product.product_type);
  if (!LACQUER_TYPES.has(productType) && !(settings.includeGel && productType === GEL_TYPE)) {
    return false;
  }
  if (tagList(product.tags).some((tag) => SET_TAGS.has(tag))) {
    return false;
  }
  const title = typeof product.title === "string" ? product.title : "";
  return !title.split(" - ").some((segment) => isRetailerSetSegment(segment));
}
