/**
 * Pieces shared by the store filters of stores that sell only their own polish and leave
 * `product_type` empty (Sweet & Sour, Penelope Luz, Noodles): the filter reads the description.
 */

/** Words a shade description uses to describe the polish's base, finish or wear. */
export const SHADE_DESCRIPTION_REGEX =
  /\b(?:shimmers?|shimmery|(?:micro)?flakes?|flakies|holographic|holo|glitters?|hexes|jelly|cr[eè]mes?|crelly|magnetic|thermal|glow(?:s|ing)?|metallic|iridescent|chrome|duochrome|multichrome|foils?|sparkles?|matte|satin|neon|sheer|shift(?:s|ing)?|topper|coats|polish(?:es)?|lacquers?)\b/i;
