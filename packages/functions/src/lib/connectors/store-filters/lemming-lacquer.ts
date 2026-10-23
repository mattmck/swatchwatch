import type { StoreFilterProduct } from "./types.js";

/**
 * Lemming Lacquer (lemminglacquer.com) product filter (#273).
 *
 * Most Lemming shades are typed "Nail Polishes" and pass the generic gate, but a
 * few carry their finish as the product type instead ("Multichrome", "Flakes"),
 * which the gate does not read as a polish signal, and the Polish Pickup mystery
 * grab bag is typed "Flakes" too. Collection listings ("Collection"), the gift
 * card and the magnet ("Acessories", sic) are dropped by the gate already.
 *
 * - Mystery listings are dropped by title, whatever their product type.
 * - A product whose product type names a finish is a single shade.
 * - Everything else defers to the generic gate (`null`).
 *
 * Fixture: tests/fixtures/lemming-lacquer-products.json (30 products, 2026-10-22).
 */

const MYSTERY_TITLE_REGEX = /\b(?:myster(?:y|ies))\b/i;

/** Finish words Lemming uses as a product type on its single shades. */
const FINISH_PRODUCT_TYPE_REGEX =
  /\b(?:multichrome|duochrome|flakes?|flakies|shimmers?|holo(?:graphic)?|jelly|crelly|cr[eè]me|magnetic|thermal|glitters?|topper)\b/i;

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function isLemmingLacquerPolish(product: StoreFilterProduct): boolean | null {
  const title = asText(product.title);
  if (MYSTERY_TITLE_REGEX.test(title)) {
    return false;
  }
  if (FINISH_PRODUCT_TYPE_REGEX.test(asText(product.product_type))) {
    return true;
  }
  return null;
}
