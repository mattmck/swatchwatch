import { lowerTrim } from "./shared.js";
import type { StoreFilterProduct } from "./types.js";

/**
 * Manucurist (manucurist.com) product filter (brand sources plan, Task 11).
 *
 * Manucurist's `product_type` values are French, and its polishes carry no English polish word, so
 * the generic gate cannot read them; its coats are tagged `Acq_Top_Base_Remover`, which the June tag
 * blocklist rejects as a remover. The same shade names are sold twice: as the Green lacquer and as
 * the Green Flash LED gel. First page on 2026-11-08: Vernis à ongles Green™ 68, Semi-permanent LED
 * Green Flash™ 59, Soins 36, Active 33, Accessoires 31, empty 10, Nail art 8, Vernis enfants 4,
 * Vernis à ongles 1. The filter maps the French types before the generic gate:
 *
 * - Dropped first, whatever the type: after-sales replacements ("(SAV) …"), upsell add-ons
 *   ("+ …"), and kits, gift boxes, pouches, routines, duos, trios, sets, Advent calendars and
 *   build-your-own sets (kit, coffret, trousse, routine, duo, trio, set, gift, calendrier,
 *   "à personnaliser").
 * - Lacquer (`Vernis à ongles Green™`, `Vernis à ongles`, `Vernis enfants`): a base or top coat
 *   title is kept (true, so the remover tag cannot drop it; materialization reads its category);
 *   a shade tagged `Acq_Nail_Polish` or `_type_vernis`, and every kids' polish, is kept; any other
 *   listing of the type (removers, the degreaser, drying drops) defers to the generic gate (null),
 *   which drops it.
 * - Gel (`Semi-permanent LED Green Flash™`): dropped unless the source's `includeGel` is true; then
 *   a coat title or an `Acq_Gel_Polish` shade is kept and the rest (lamps, removal tools) deferred.
 * - Care (`Soins`, and the tinted-care `Active` line): a base or top coat title is kept; the rest
 *   defers to the generic gate, which reads coats and treatments from English titles only.
 * - Every other type (Accessoires, Nail art, empty) is dropped.
 *
 * Fixture: tests/fixtures/manucurist-products.json (104 of the 250 first-page products, 2026-11-08).
 */

const LACQUER_TYPES: ReadonlySet<string> = new Set(["vernis à ongles green™", "vernis à ongles", "vernis enfants"]);
const KIDS_TYPE = "vernis enfants";
const GEL_TYPE = "semi-permanent led green flash™";
const CARE_TYPES: ReadonlySet<string> = new Set(["soins", "active"]);
const LACQUER_TAGS: ReadonlySet<string> = new Set(["acq_nail_polish", "_type_vernis"]);
const GEL_TAG = "acq_gel_polish";

const NON_SHADE_TITLE_REGEX =
  /^\s*(?:\(sav\)|\+)|\b(?:kits?|coffrets?|trousses?|routines?|duos?|trios?|sets?|gift|calendrier)\b|personnaliser/i;
const COAT_TITLE_REGEX = /\b(?:base|top)\s*coats?\b/i;

function tagSet(tags: unknown): Set<string> {
  const list = Array.isArray(tags) ? tags : typeof tags === "string" ? tags.split(",") : [];
  return new Set(list.map(lowerTrim).filter(Boolean));
}

/** Store filter for Manucurist (ManucuristShopify): `true` keeps the product, `false` drops it, `null` defers to the generic polish gate. */
export function isManucuristPolish(
  product: StoreFilterProduct,
  settings: { includeGel: boolean } = { includeGel: false }
): boolean | null {
  const title = typeof product.title === "string" ? product.title : "";
  if (NON_SHADE_TITLE_REGEX.test(title)) {
    return false;
  }
  const productType = lowerTrim(product.product_type);
  const isCoat = COAT_TITLE_REGEX.test(title);
  const tags = tagSet(product.tags);
  if (LACQUER_TYPES.has(productType)) {
    if (isCoat || productType === KIDS_TYPE || [...LACQUER_TAGS].some((tag) => tags.has(tag))) {
      return true;
    }
    return null;
  }
  if (productType === GEL_TYPE) {
    if (!settings.includeGel) {
      return false;
    }
    return isCoat || tags.has(GEL_TAG) ? true : null;
  }
  if (CARE_TYPES.has(productType)) {
    return isCoat ? true : null;
  }
  return false;
}
