import type { StoreFilterProduct } from "./types.js";

/**
 * China Glaze (chinaglaze.com): product filter and shade-name parser for `ChinaGlazeShopify`.
 *
 * Measured on the first ingest (2026-11-10, 75 stored products): 71 polishes and coats under the
 * vendor "CG" (aliased to China Glaze in `data_source.metadata.vendorAliases`), product_type
 * "Nail Lacquers", titles shouted in capitals ("ALPENGLOW", "CRUSHIN' ON BLUE", "XOXO, YOU'RE
 * IT"); one "China Glaze" basecoat; three cuticle-care products of the sister brand Flowery.
 *
 * - vendor CG or China Glaze → deferred to the generic gate;
 * - any other vendor (Flowery) → dropped: the store is the authority for China Glaze only.
 */

const CHINA_GLAZE_VENDORS: ReadonlySet<string> = new Set(["cg", "china glaze"]);

export function isChinaGlazePolish(product: StoreFilterProduct): boolean | null {
  const vendor = typeof product.vendor === "string" ? product.vendor.trim().toLowerCase() : "";
  return CHINA_GLAZE_VENDORS.has(vendor) ? null : false;
}

/** Capitalised words China Glaze names use as acronyms ("DM FOR DRAMA", "IRL SPARKLE", "XOXO, YOU'RE IT"). */
const ACRONYMS: ReadonlySet<string> = new Set(["DM", "IRL", "XOXO"]);

/** One all-caps word as a person writes it: first letter up, the rest (after ' or -) down. */
function titleCaseWord(word: string): string {
  const letters = word.replace(/[^\p{L}]/gu, "");
  if (!letters || letters !== letters.toUpperCase() || letters === letters.toLowerCase()) {
    return word; // no letters, or already mixed / lower case
  }
  if (ACRONYMS.has(letters)) {
    return word;
  }
  const lower = word.toLowerCase();
  const first = lower.search(/\p{L}/u);
  return lower.slice(0, first) + lower.charAt(first).toUpperCase() + lower.slice(first + 1);
}

/**
 * Title-cases every whitespace-separated word written in capitals ("CRUSHIN' ON BLUE" →
 * "Crushin' On Blue", "FLAME-BOYANT" → "Flame-boyant"); a word with any lower-case letter
 * ("McLove") and the acronyms DM, IRL and XOXO stay as written. Every word is capitalised,
 * including short ones ("Left My Heart In Havana").
 */
export function titleCaseShoutedWords(text: string): string {
  return text
    .split(/(\s+)/)
    .map((part) => (/\s/.test(part) ? part : titleCaseWord(part)))
    .join("");
}

/** China Glaze: the title with its shouted words title-cased; null when nothing changes. */
export function parseChinaGlazeTitle(product: StoreFilterProduct): string | null {
  const title = typeof product.title === "string" ? product.title.trim() : "";
  if (!title) {
    return null;
  }
  const name = titleCaseShoutedWords(title);
  return name === title ? null : name;
}
