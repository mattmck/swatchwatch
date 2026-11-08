import { lowerTrim } from "./shared.js";
import type { StoreFilterProduct } from "./types.js";

/**
 * Côte (coteshop.co) product filter (brand sources plan, Phase C review I2).
 *
 * Côte sells its polish next to lip, body, hair and home products. The generic gate handles the
 * page except for the lip treatment ("The Ritual Peptide Enriched Lip Treatment", typed `lip
 * treatment`), which it keeps as a nail treatment. The filter drops every product whose
 * `product_type` names lips and defers everything else to the generic gate (null). First page on
 * 2026-11-08: 129 products (Nail Polishes 66, gift set 11, lip shine 9, treatment 8, body 8).
 *
 * Fixture: tests/fixtures/cote-products.json (2026-11-08, fixture _note).
 */

const LIP_TYPE_REGEX = /\blips?\b/;

export function isCotePolish(product: StoreFilterProduct): boolean | null {
  return LIP_TYPE_REGEX.test(lowerTrim(product.product_type)) ? false : null;
}
