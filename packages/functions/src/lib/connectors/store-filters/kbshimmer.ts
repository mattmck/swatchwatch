import type { StoreFilterProduct } from "./types.js";

/**
 * KBShimmer (www.kbshimmer.com, WooCommerce Store API, `KbshimmerWooCommerce`) product filter and
 * title parser.
 *
 * The store sells its own polish next to hand and body care and Polish & Beauty Expo merch, all
 * under polish-looking categories, so the generic gate kept tumblers and sweatshirts as shades on
 * the first run (2026-11-11, 299 of 371 products kept). The filter drops by title: tumblers, cups,
 * sweatshirts and shirts, coat refills (the coat itself is its own listing), hand & body scrubs,
 * cuticle oils and creams, Mani Shots, polish thinner and dropper tops, stickers, magnets, gift cards
 * and the mystery polish. Any
 * other product defers to the generic gate (`null`), which keeps polish, toppers and coats.
 *
 * Titles carry a descriptor suffix ("Tricked Out Reflective Nail Polish", "Prism Break Glitter
 * Polish Topper", "“D’oh!” Nail Polish – PBE 2026 Exclusive"), so the brand-mode name did not match
 * the shades resellers had already created ("Tricked Out"): 135 duplicates on the first run.
 * `parseKbshimmerTitle` drops an edition note, the "Nail Polish" / "Polish Topper" suffix and the
 * finish words before it, which matched 197 of the 299 titles to an existing shade.
 */

const NON_SHADE_TITLE_REGEX = new RegExp(
  "\\b(?:" +
    [
      "tumbl?ers?",
      "tumber", // "Black Rainbow 40 oz Stainless Steel Tumber"
      "cups?",
      "sweatshirts?",
      "t-?shirts?",
      "hoodies?",
      "refills?",
      "scrubs?",
      "cuticle\\s+(?:oil|cream)",
      "mani\\s+shots?",
      "stickers?",
      "magnets?",
      "gift\\s*(?:cards?|certificates?)",
      "myster(?:y|ies)",
      "thinners?",
      "droppers?",
    ].join("|") +
    ")\\b",
  "i"
);

/** Store filter for KBShimmer: `false` drops a known non-shade listing, `null` defers to the generic gate. */
export function isKbshimmerPolish(product: StoreFilterProduct): boolean | null {
  const title = typeof product.title === "string" ? product.title : "";
  return NON_SHADE_TITLE_REGEX.test(title) ? false : null;
}

/** A trailing edition note after a dash: " – PBE 2026 Exclusive", " – PPU January 2026". */
const EDITION_NOTE_REGEX = /\s+[–—-]\s+(?:PBE\s+\d{4}\s+Exclusive|PPU(?:\s+\w+)?(?:\s+\d{4})?)\s*$/i;
/** "Nail Polish", "Nail Polish Topper", "Glitter Polish Topper", "Glitter Nail Polish Topper". */
const POLISH_SUFFIX_REGEX = /\s+(?:(?:glitter\s+)?(?:nail\s+)?polish\s+topper|nail\s+polish)\s*$/i;
/** Finish and effect words KBShimmer puts between the shade name and "Nail Polish". */
const FINISH_WORD =
  "(?:multichrome|magnetic|(?:rainbow\\s+)?reflective|cr[eè]me|tri-thermal|thermal|glow-in-the-dark|flakies?|flakes?|ir(?:i)?descent|holographic|holo|jelly|crelly|shimmer|glitter)";
const TRAILING_FINISHES_REGEX = new RegExp(`(?:\\s+${FINISH_WORD})+\\s*$`, "i");

/**
 * KBShimmer's shade name: "Tricked Out Reflective Nail Polish" → "Tricked Out", "Prism Break
 * Glitter Polish Topper" → "Prism Break", "“D’oh!” Nail Polish – PBE 2026 Exclusive" → "D’oh!".
 * Null (keep the title) for a title without the polish suffix: coats, treatments, the rest.
 */
export function parseKbshimmerTitle(product: StoreFilterProduct): string | null {
  const title = typeof product.title === "string" ? product.title.trim() : "";
  const withoutNote = title.replace(EDITION_NOTE_REGEX, "");
  const suffix = POLISH_SUFFIX_REGEX.exec(withoutNote);
  if (!suffix) return null;
  const base = withoutNote.slice(0, suffix.index).trim();
  const name = (base.replace(TRAILING_FINISHES_REGEX, "").trim() || base).replace(/^[“"]+|[”"]+$/g, "").trim();
  return name || null;
}
