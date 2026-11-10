import { classifyIngestedProduct, type IngestedProductClassification } from "../product-category.js";
import {
  parseAlchemyLacquersTitle,
  parseBarryMTitle,
  parseCoteTitle,
  parsePiggyPaintTitle,
  parseWetNWildTitle,
} from "./store-filters/brand-store-titles.js";
import { parsePaintedPolishTitle } from "./store-filters/painted-polish.js";
import { parsePicturePolishTitle } from "./store-filters/picture-polish.js";
import { parsePolishPickupTitle } from "./store-filters/polish-pickup-title.js";
import { parsePotionPolishTitle } from "./store-filters/potion-polish.js";
import type { StoreFilterProduct, StoreTitleParser } from "./store-filters/types.js";

export {
  parseAlchemyLacquersTitle,
  parseBarryMTitle,
  parseCoteTitle,
  parsePaintedPolishTitle,
  parsePicturePolishTitle,
  parsePiggyPaintTitle,
  parsePolishPickupTitle,
  parsePotionPolishTitle,
  parseWetNWildTitle,
};
export { parseLineAndShadeTitle } from "./store-filters/brand-store-titles.js";

/**
 * Per-source shade-name parsers for stores whose product title is not the shade name: the
 * Polish Pickup retailer, and brand stores whose titles carry a line prefix or a descriptor
 * suffix (wet n wild, Barry M, Piggy Paint, Côte, Alchemy Lacquers). Keyed by
 * `data_source.name`, so the non-Shopify connectors use it too: the WooCommerce and Big Cartel
 * gates ask `shopifyStoreShadeName` before their own title parsing (Picture Polish, Painted
 * Polish, Potion Polish). The raw title is always kept as `normalized.rawTitle`.
 */
export const SHOPIFY_STORE_TITLE_PARSERS: Readonly<Record<string, StoreTitleParser>> = {
  PolishPickupShopify: parsePolishPickupTitle,
  WetNWildShopify: parseWetNWildTitle,
  BarryMShopify: parseBarryMTitle,
  PiggyPaintShopify: parsePiggyPaintTitle,
  CoteShopify: parseCoteTitle,
  AlchemyLacquersShopify: parseAlchemyLacquersTitle,
  // Non-Shopify brand stores (enabled 2026-11-10).
  PicturePolishWooCommerce: parsePicturePolishTitle,
  PaintedPolishBigCartel: parsePaintedPolishTitle,
  PotionPolishBigCartel: parsePotionPolishTitle,
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
 * The connector gate's classification of a product whose store title parser named the shade
 * (`storeShadeName`, null when it has none): the raw title is classified, as in the Shopify gate,
 * unless it reads as a set (evidence `set`) and the parsed name does not. Then the dropped note
 * was the only set wording, as in Painted Polish's "(FINAL 3 BOTTLES)" stock note ("3 bottles"),
 * and the parsed name is classified instead. `shadeText` is the text that was classified.
 */
export function classifyWithStoreShadeName(
  title: string,
  storeShadeName: string | null,
  productType: string | null,
  tags: readonly string[]
): { gate: IngestedProductClassification; shadeText: string } {
  const gate = classifyIngestedProduct({ title, productType, tags });
  if (storeShadeName && gate.evidence === "set") {
    const parsed = classifyIngestedProduct({ title: storeShadeName, productType, tags });
    if (parsed.evidence !== "set") {
      return { gate: parsed, shadeText: storeShadeName };
    }
  }
  return { gate, shadeText: title };
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
