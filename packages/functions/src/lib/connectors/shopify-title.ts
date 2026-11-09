import {
  parseAlchemyLacquersTitle,
  parseBarryMTitle,
  parseCoteTitle,
  parsePiggyPaintTitle,
  parseWetNWildTitle,
} from "./store-filters/brand-store-titles.js";
import { parsePolishPickupTitle } from "./store-filters/polish-pickup-title.js";
import type { StoreFilterProduct, StoreTitleParser } from "./store-filters/types.js";

export {
  parseAlchemyLacquersTitle,
  parseBarryMTitle,
  parseCoteTitle,
  parsePiggyPaintTitle,
  parsePolishPickupTitle,
  parseWetNWildTitle,
};
export { parseLineAndShadeTitle } from "./store-filters/brand-store-titles.js";

/**
 * Per-source shade-name parsers for stores whose product title is not the shade name: the
 * Polish Pickup retailer, and brand stores whose titles carry a line prefix or a descriptor
 * suffix (wet n wild, Barry M, Piggy Paint, Côte, Alchemy Lacquers).
 */
export const SHOPIFY_STORE_TITLE_PARSERS: Readonly<Record<string, StoreTitleParser>> = {
  PolishPickupShopify: parsePolishPickupTitle,
  WetNWildShopify: parseWetNWildTitle,
  BarryMShopify: parseBarryMTitle,
  PiggyPaintShopify: parsePiggyPaintTitle,
  CoteShopify: parseCoteTitle,
  AlchemyLacquersShopify: parseAlchemyLacquersTitle,
};

/**
 * Retailer sources whose own title parser stands in for retailer-mode titles and also yields
 * release tags (monthly drops). Brand-store parsers are not listed: their stores have no drops.
 */
export const SHOPIFY_TITLE_PARSER_SOURCES: readonly string[] = ["PolishPickupShopify"];

/** The store's shade name for `product`, or null when `source` has no parser or it declined. */
export function shopifyStoreShadeName(
  source: string,
  product: StoreFilterProduct & { vendor?: unknown }
): string | null {
  const parser = Object.prototype.hasOwnProperty.call(SHOPIFY_STORE_TITLE_PARSERS, source)
    ? SHOPIFY_STORE_TITLE_PARSERS[source]
    : undefined;
  return parser ? parser(product) : null;
}

/**
 * Removes one trailing whitespace-separated `PPU` token (or `(PPU)`): Polish Pickup
 * exclusives carry it in the shade name on some brand stores too. Case-sensitive;
 * returns the input when stripping would leave nothing.
 */
export function stripRetailerExclusiveSuffix(name: string): string {
  const stripped = name.replace(/(?:\s+PPU|\s*\(PPU\))\s*$/, "").trim();
  return stripped ? stripped : name;
}

/** The first `Cap: N` (edition size) in product description text, else null. */
export function parseEditionCap(text: string | null): number | null {
  if (!text) {
    return null;
  }
  const match = /Cap:\s*(\d{1,5})/.exec(text);
  return match ? Number(match[1]) : null;
}
