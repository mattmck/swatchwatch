/**
 * Retailer listing title parser. Multi-brand stores (Beyond Polish, Harlow & Co,
 * Hypnotic Polish) title listings like
 * "OPI Nail Lacquer - No Room for the Blues 0.5 oz - #NLB83": brand, product
 * line, shade, size and vendor code in one string. Pure, no I/O.
 */

export interface RetailerTitle {
  shadeName: string;
  productLine: string | null;
  vendorCode: string | null;
  isSet: boolean;
}

/** Segments naming a product line ("Nail Lacquer", "Infinite Shine", "Lakur Enhanced Colour"). */
export const RETAILER_LINE_REGEX =
  /\b(?:nail lacquer|nail polish|lacquer|polish|infinite shine|nature strong|vinylux|shellac|lakur|pure colour|patent shine|gel lab pro|gel couture|breathable|enhanced colour)\b/i;

/**
 * Words marking a multi-item listing (set, combo, duo, collection ...). A set word counts only as
 * the last word of a segment ("Sonnet Fall Collection"), so a shade like "Set Sail" is not a set.
 * Apply it with `isRetailerSetSegment`, which trims trailing punctuation first.
 */
export const RETAILER_SET_REGEX = /\b(?:sets?|combo|duo|trio|quad|collection|kit|bundle)$/i;

/** Whether one title segment (size already stripped) ends in a set word. */
export function isRetailerSetSegment(segment: string): boolean {
  return RETAILER_SET_REGEX.test(segment.replace(/[\s.,;:!?*)\]]+$/, ""));
}

const PRE_ORDER_REGEX = /^\s*(?:\*PRE-ORDER\*|PRE-ORDER:)\s*/i;
const VENDOR_CODE_REGEX = /^#\s*([A-Z0-9][A-Z0-9.-]*)$/i;
// At least two characters: "Lucky #7" is a shade number, not a vendor code.
const TRAILING_CODE_REGEX = /\s+#([A-Z0-9][A-Z0-9.-]+)$/i;
const TRAILING_SIZE_REGEX = /\s*\(?\d*\.?\d+\s*(?:oz|ml)\.?\)?$/i;
const TRAILING_MULTIPACK_REGEX = /\s*\d+X Nail Lacquer$/i;
const TRAILING_FINISH_REGEX = /\s*\((?:magnetic|thermal|flakie|shimmer|holo)\)$/i;
const LEADING_LACQUER_SET_REGEX = /^\s*Lacquer Set\b/i;

/** A code written at the end of a sentence ("#1122.") loses the dot. */
function trimCode(code: string): string {
  return code.replace(/\.+$/, "");
}

function normalizeSpace(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function stripBrand(segments: string[], brands: readonly string[]): string[] {
  const first = segments[0];
  if (first === undefined) return segments;
  const have = normalizeSpace(first);
  for (const brand of brands) {
    const wanted = normalizeSpace(brand);
    if (!wanted) continue;
    if (have === wanted) return segments.slice(1);
    if (have.startsWith(`${wanted} `)) {
      // Keep the remainder with its original casing.
      const rest = first.trim().replace(/\s+/g, " ").slice(wanted.length).trim();
      return [rest, ...segments.slice(1)];
    }
  }
  return segments;
}

/**
 * Parses one listing title. `brand` is the resolved brand; `extraPrefixes` are other spellings a
 * title may start with (the raw vendor when an alias renamed it: vendor "Lippmann", brand
 * "Deborah Lippmann", title "Lippmann Celeste"), stripped like the brand.
 */
export function parseRetailerTitle(
  title: string,
  brand: string,
  extraPrefixes: readonly string[] = []
): RetailerTitle | null {
  const cleaned = title.replace(PRE_ORDER_REGEX, "").trim();
  if (!cleaned) return null;

  let segments = cleaned.split(" - ").map((s) => s.trim());
  segments = stripBrand(segments, [brand, ...extraPrefixes]);

  let vendorCode: string | null = null;
  const names: string[] = [];
  for (const segment of segments) {
    const code = VENDOR_CODE_REGEX.exec(segment);
    if (code) {
      vendorCode = trimCode(code[1]);
      continue;
    }
    // A code glued to the end of a segment ("Skinny Dip 0.5 oz #1122").
    const inlineCode = TRAILING_CODE_REGEX.exec(segment);
    if (inlineCode) vendorCode ??= trimCode(inlineCode[1]);
    const stripped = segment
      .replace(TRAILING_CODE_REGEX, "")
      .replace(TRAILING_SIZE_REGEX, "")
      .replace(TRAILING_MULTIPACK_REGEX, "")
      .trim();
    if (stripped) names.push(stripped);
  }

  const isSet = LEADING_LACQUER_SET_REGEX.test(cleaned) || names.some(isRetailerSetSegment);

  const lines: string[] = [];
  const shades: string[] = [];
  for (const name of names) {
    if (names.length > 1 && RETAILER_LINE_REGEX.test(name)) lines.push(name);
    else shades.push(name);
  }
  // Every segment reads like a line ("Nail Polish - Lacquer Up"): the last one is the shade.
  const lastLine = lines.length > 0 && shades.length === 0 ? lines.pop() : undefined;
  if (lastLine !== undefined) shades.push(lastLine);

  const shadeName = shades[shades.length - 1]?.replace(TRAILING_FINISH_REGEX, "").trim();
  if (!shadeName) return null;

  return { shadeName, productLine: lines.length ? lines.join(" ") : null, vendorCode, isSet };
}
