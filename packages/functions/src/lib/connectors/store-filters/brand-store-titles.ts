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
/** A further separator after the shade: the start of a size or colour-change note. */
const NOTE_SEPARATOR = /\s+[|-]\s+/;

/**
 * `"<Line> | <Shade>"` → `{ productLine: <Line>, name: <Shade> }`, split on the first " | ";
 * null when the title has no " | " or either side is empty. With `dropSeparatedNote`, a
 * trailing note after the shade that starts with another " | " or " - " is dropped; a note
 * without a separator stays part of the name.
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

/**
 * Barry M: "Gelly Hi Shine Nail Paint | Black Cherry" → "Black Cherry"; a size or colour-change
 * note after the shade is dropped when a separator introduces it ("| Black Cherry - 10ml") and
 * kept otherwise ("| White to Pink C").
 */
export function parseBarryMTitle(product: StoreFilterProduct): string | null {
  return parseLineAndShadeTitle(asText(product.title), { dropSeparatedNote: true })?.name ?? null;
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
