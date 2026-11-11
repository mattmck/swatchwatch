import { isAlchemyLacquersPolish } from "./alchemy-lacquers.js";
import { isBarryMPolish } from "./barry-m.js";
import { isBeyondPolishPolish } from "./beyond-polish.js";
import { isChinaGlazePolish } from "./china-glaze.js";
import { isCirqueColorsPolish } from "./cirque-colors.js";
import { isCndPolish } from "./cnd.js";
import { isCotePolish } from "./cote.js";
import { isHarlowAndCoPolish } from "./harlow-and-co.js";
import { isHypnoticPolishPolish } from "./hypnotic-polish.js";
import { isLemmingLacquerPolish } from "./lemming-lacquer.js";
import { isLeMiniMacaronPolish } from "./le-mini-macaron.js";
import { isLondontownPolish } from "./londontown.js";
import { isManucuristPolish } from "./manucurist.js";
import { isNoodlesPolish } from "./noodles.js";
import { isOliveAndJunePolish } from "./olive-and-june.js";
import { isPahlishPolish } from "./pahlish.js";
import { isPaintedPolishPolish } from "./painted-polish.js";
import { isPenelopeLuzPolish } from "./penelope-luz.js";
import { isPicturePolishPolish } from "./picture-polish.js";
import { isPiggyPaintPolish } from "./piggy-paint.js";
import { isPolishPickupPolish } from "./polish-pickup.js";
import { isPotionPolishPolish } from "./potion-polish.js";
import { isStellaChromaPolish } from "./stella-chroma.js";
import { isSweetAndSourPolish } from "./sweet-and-sour.js";
import { isWetNWildPolish } from "./wet-n-wild.js";
import type { SourceSettings } from "../../source-settings.js";
import type { StoreFilterProduct, StoreProductFilter } from "./types.js";

export type { StoreFilterProduct, StoreProductFilter, StoreTitleParser } from "./types.js";

/**
 * Per-source product filters for stores whose products the generic polish gate cannot classify
 * (#328, #273). Keyed by `data_source.name`, so the registry also serves the non-Shopify
 * connectors: the WooCommerce and Big Cartel gates ask it too (over `wooStoreFilterProduct` /
 * `bigCartelStoreFilterProduct`, the same platform-neutral fields), which is why Picture Polish,
 * Painted Polish and Potion Polish are here rather than in a parallel map. A connector asks this
 * map first; a source without an entry, or a filter that returns null, falls through to the
 * generic gate. Bundle and set exclusion still apply after.
 */
export const SHOPIFY_STORE_PRODUCT_FILTERS: Readonly<Record<string, StoreProductFilter>> = {
  PahlishShopify: isPahlishPolish,
  CirqueColorsShopify: isCirqueColorsPolish,
  StellaChromaShopify: isStellaChromaPolish,
  LemmingLacquerShopify: isLemmingLacquerPolish,
  SweetAndSourLacquerShopify: isSweetAndSourPolish,
  PolishPickupShopify: isPolishPickupPolish,
  HarlowAndCoShopify: isHarlowAndCoPolish,
  BeyondPolishShopify: isBeyondPolishPolish,
  HypnoticPolishShopify: isHypnoticPolishPolish,
  LondontownShopify: isLondontownPolish,
  ManucuristShopify: isManucuristPolish,
  OliveAndJuneShopify: isOliveAndJunePolish,
  PiggyPaintShopify: isPiggyPaintPolish,
  PenelopeLuzShopify: isPenelopeLuzPolish,
  NoodlesNailPolishShopify: isNoodlesPolish,
  CndShopify: isCndPolish,
  BarryMShopify: isBarryMPolish,
  WetNWildShopify: isWetNWildPolish,
  CoteShopify: isCotePolish,
  AlchemyLacquersShopify: isAlchemyLacquersPolish,
  // Brand stores whose first ingest (2026-11-10) needed a fix: another brand's care items (China
  // Glaze), gel and LED lines (Le Mini Macaron).
  ChinaGlazeShopify: isChinaGlazePolish,
  LeMiniMacaronShopify: isLeMiniMacaronPolish,
  // Non-Shopify brand stores (enabled 2026-11-10).
  PicturePolishWooCommerce: isPicturePolishPolish,
  PaintedPolishBigCartel: isPaintedPolishPolish,
  PotionPolishBigCartel: isPotionPolishPolish,
};

/** The store filter's verdict for `product`, or null when `source` has none. */
export function shopifyStoreProductVerdict(
  source: string,
  product: StoreFilterProduct,
  settings?: SourceSettings
): boolean | null {
  const filter = Object.prototype.hasOwnProperty.call(SHOPIFY_STORE_PRODUCT_FILTERS, source)
    ? SHOPIFY_STORE_PRODUCT_FILTERS[source]
    : undefined;
  return filter ? filter(product, settings) : null;
}
