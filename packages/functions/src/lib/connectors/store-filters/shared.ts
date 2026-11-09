/**
 * Pieces shared by the store filters of stores that sell only their own polish and leave
 * `product_type` empty (Sweet & Sour, Penelope Luz, Noodles): the filter reads the description.
 */

/** Words a shade description uses to describe the polish's base, finish or wear. */
export const SHADE_DESCRIPTION_REGEX =
  /\b(?:shimmers?|shimmery|(?:micro)?flakes?|flakies|holographic|holo|glitters?|hexes|jelly|cr[eè]mes?|crelly|magnetic|thermal|glow(?:s|ing)?|metallic|iridescent|chrome|duochrome|multichrome|foils?|sparkles?|matte|satin|neon|sheer|shift(?:s|ing)?|topper|coats|polish(?:es)?|lacquers?)\b/i;

/** A string field lower-cased and trimmed; anything else is "". */
export function lowerTrim(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * A string field as plain text: `<style>` and `<script>` elements removed (Noodles descriptions open
 * with kilobytes of inline CSS), then every other tag replaced by a space; anything else is "".
 */
export function stripHtml(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ").replace(/<[^>]*>/g, " ")
    : "";
}

/**
 * A mystery or grab-bag listing ("Mystery Bag", "Mystery Polishes", "Halloween Grab Bag", "Blind
 * Bag"): never one shade, whatever its category says. "Mystery" alone is not enough, so a shade
 * named "Mystery" or "Midnight Mystery" is kept. The WooCommerce and Big Cartel gates reject a
 * matching title before the category gate, because a store category ("Nail Polish") can carry a
 * polish signal.
 */
export const MYSTERY_TITLE_REGEX = /\bmystery\s+(?:bag|box|polish|pack)e?s?\b|\b(?:grab|surprise|blind)\s+bags?\b/i;
