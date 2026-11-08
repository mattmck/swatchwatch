import type { StoreFilterProduct } from "./types.js";

/**
 * Shade-name parsers for brand stores whose product title is not the bare shade name (brand
 * sources plan, Phase C review I1). Each one returns the shade name, or null to keep the raw
 * title; the raw title is still stored as `normalized.rawTitle`.
 */

/** A title split into its product line and shade name. */
export interface LineAndShadeTitle {
  name: string;
  productLine: string;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

const PIPE_SEPARATOR = /\s+\|\s+/;
/**
 * A further " | " after the shade: the start of a size or colour-change note. Not " - ", which a
 * shade name may contain.
 */
const NOTE_SEPARATOR = /\s+\|\s+/;

/**
 * `"<Line> | <Shade>"` → `{ productLine: <Line>, name: <Shade> }`, split on the first " | ";
 * null when the title has no " | " or either side is empty. With `dropSeparatedNote`, a
 * trailing note after the shade that starts with another " | " is dropped; anything else
 * (including " - ") stays part of the name.
 */
export function parseLineAndShadeTitle(
  title: string,
  options: { dropSeparatedNote?: boolean } = {}
): LineAndShadeTitle | null {
  const match = PIPE_SEPARATOR.exec(title);
  if (!match) {
    return null;
  }
  const productLine = title.slice(0, match.index).trim();
  let name = title.slice(match.index + match[0].length).trim();
  if (options.dropSeparatedNote) {
    const note = NOTE_SEPARATOR.exec(name);
    if (note) {
      name = name.slice(0, note.index).trim();
    }
  }
  return productLine && name ? { name, productLine } : null;
}

/** wet n wild: "Fast Dry AF Nail Color | Get Stoned" → "Get Stoned"; a title without " | " is kept. */
export function parseWetNWildTitle(product: StoreFilterProduct): string | null {
  return parseLineAndShadeTitle(asText(product.title))?.name ?? null;
}

/** A Barry M line that names a treatment or a coat: its "| <word>" is the variant, not a shade. */
const BARRY_M_CARE_LINE_REGEX =
  /\b(?:treatments?|base\s*coats?|top\s*coats?|nail\s+care|strengthen|repair|nourish|hydrate)\b/i;

/**
 * Barry M: "Gelly Hi Shine Nail Paint | Black Cherry" → "Black Cherry"; a note after the shade
 * introduced by another " | " is dropped, while " - " and unseparated notes ("| White to Pink C")
 * stay. A line naming a treatment or coat keeps the whole title ("Mani Hero Nail Treatment |
 * Strengthen"), because "Strengthen" alone is not a shade.
 */
export function parseBarryMTitle(product: StoreFilterProduct): string | null {
  const parsed = parseLineAndShadeTitle(asText(product.title), { dropSeparatedNote: true });
  if (!parsed || BARRY_M_CARE_LINE_REGEX.test(parsed.productLine)) {
    return null;
  }
  return parsed.name;
}

const COTE_SUFFIX_REGEX = /\s+nail\s+(?:polish|lacquer)$/i;

/**
 * Côte: "Pink Clouds Nail Polish" → "Pink Clouds" (also " Nail Lacquer", any case); a title that
 * is only that phrase, or has no such suffix ("Quick Dry Top Coat"), is kept whole.
 */
export function parseCoteTitle(product: StoreFilterProduct): string | null {
  const title = asText(product.title);
  const match = COTE_SUFFIX_REGEX.exec(title);
  if (!match) {
    return null;
  }
  const name = title.slice(0, match.index).trim();
  return name ? name : null;
}

/**
 * Words an Alchemy Lacquers title note may use for a finish, topper or edition. Solar and
 * reflective come from the 2026-11-08 page ("(Solar)", "(Solar & Thermal)", "(Reflective)").
 */
const ALCHEMY_NOTE_TERM_REGEX =
  /^(?:magnetic|thermal|solar|flakies?|shimmer|holo(?:graphic)?|glitter\s+topper|topper|crelly|jelly|multichrome|duochrome|le|limited\s+edition|reflective|glow|neon|matte)$/i;
const TRAILING_NOTE_REGEX = /\s*\(([^()]*)\)$/;

/**
 * Alchemy Lacquers: drops ONE trailing parenthetical when every term in it (split on "&", "and",
 * "/" and ",") is a finish, topper or edition word ("Cauldron of Chaos (Magnetic)" → "Cauldron of
 * Chaos", "(Solar & Thermal)"); any other note stays ("Quicksilver Top Coat (Quick Dry, Glossy,
 * 5 Free)", "Glitter Elixir (Smoothing Top Coat)").
 */
export function parseAlchemyLacquersTitle(product: StoreFilterProduct): string | null {
  const title = asText(product.title);
  const match = TRAILING_NOTE_REGEX.exec(title);
  if (!match) {
    return null;
  }
  const terms = match[1].split(/\s*(?:&|\band\b|\/|,)\s*/i).map((term) => term.trim());
  if (terms.length === 0 || !terms.every((term) => ALCHEMY_NOTE_TERM_REGEX.test(term))) {
    return null;
  }
  const name = title.slice(0, match.index).trim();
  return name ? name : null;
}

const DASH_SEPARATOR = /\s+-\s+/;

/**
 * Piggy Paint: "<Shade> - <descriptor>" → "<Shade>" ("Bossy Blueberry - Scented Blue",
 * "Yippee Yellow Piggy Paint Pen - Kids Non-toxic Nail Polish"), split on the first " - ".
 * The part before it must be a plausible shade name (at least two characters with a letter, not
 * the vendor); a title without " - " is kept.
 */
export function parsePiggyPaintTitle(product: StoreFilterProduct): string | null {
  const title = asText(product.title);
  const match = DASH_SEPARATOR.exec(title);
  if (!match) {
    return null;
  }
  const head = title.slice(0, match.index).trim();
  const vendor = asText(product.vendor).toLowerCase();
  if (head.length < 2 || !/\p{L}/u.test(head) || head.toLowerCase() === vendor) {
    return null;
  }
  return head;
}
