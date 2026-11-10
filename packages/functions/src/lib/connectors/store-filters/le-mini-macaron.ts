import type { SourceSettings } from "../../source-settings.js";
import type { LineAndShadeTitle } from "./brand-store-titles.js";
import type { StoreFilterProduct } from "./types.js";

/**
 * Le Mini Macaron (leminimacaron.eu): product filter and shade-name parser for
 * `LeMiniMacaronShopify`.
 *
 * Measured on the first ingest (2026-11-10, 181 stored products): vendors "Le Mini Macaron
 * Europe" (143) and "Camelia Beauty" (38, the company's gel shades), both aliased to Le Mini
 * Macaron in `data_source.metadata.vendorAliases`. Product types: Individual Gel Polish 114,
 * LED Nail Polish 15, Builder Gel 4, Gel Top Coat 3, Gel / LED Base and Top Coat 3, Nail Polish
 * Color 27, Nail Polish Top Coat 4, Nail Polish Base Coat 1, Nail & Hand Care 8, Nail Prep 2.
 * Titles carry the line after the shade: "Fleur Bleue - Quick Dry Nail Polish", "Lilac Blossom -
 * LED Polish", "Lily Rose - Gel Polish", "Lavender Haze - Cat Eye Gel Polish".
 *
 * - a product type naming Gel or LED → dropped, unless the source sets `includeGel` (then
 *   deferred to the generic gate);
 * - everything else → deferred to the generic gate (care items stay governed by it).
 */

const GEL_TYPE_REGEX = /\b(?:gel|led)\b/i;

export function isLeMiniMacaronPolish(
  product: StoreFilterProduct,
  settings?: Pick<SourceSettings, "includeGel">
): boolean | null {
  const productType = typeof product.product_type === "string" ? product.product_type : "";
  if (GEL_TYPE_REGEX.test(productType) && !settings?.includeGel) {
    return false;
  }
  return null;
}

/** The last " - " (or spaced en dash) of a title. */
const LAST_DASH_REGEX = /\s+[-–]\s+(?!.*\s[-–]\s)/;
/** The product lines a shade title ends with; a coat or care product's dash part is not one. */
const SHADE_LINE_REGEX =
  /^(?:quick dry nail polish|nail polish|(?:cat eye )?gel polish|le gel polish liner|led polish|gel top coat)$/i;

/**
 * "<Shade> - <line>" → `{ name: <Shade>, productLine: <line> }` for the lines above, split on the
 * last " - "; null for any other title ("Le Sweet - Matte Top Coat", "Rosé Kiss - Nail & Cuticle
 * Oil", "Nail Strengthener").
 */
export function parseLeMiniMacaronTitleParts(product: StoreFilterProduct): LineAndShadeTitle | null {
  const title = typeof product.title === "string" ? product.title.trim() : "";
  const match = LAST_DASH_REGEX.exec(title);
  if (!match) {
    return null;
  }
  const productLine = title.slice(match.index + match[0].length).trim();
  const name = title.slice(0, match.index).replace(/\s+/g, " ").trim();
  return name && SHADE_LINE_REGEX.test(productLine) ? { name, productLine } : null;
}

/** Le Mini Macaron: the shade name before the line, or null to keep the title. */
export function parseLeMiniMacaronTitle(product: StoreFilterProduct): string | null {
  return parseLeMiniMacaronTitleParts(product)?.name ?? null;
}
