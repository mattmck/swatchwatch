import { COLOR_FAMILIES, isColorFamily, type ColorFamily } from "swatchwatch-shared";

/**
 * Parse the `/polishes?family=` URL value (comma-separated) into families in canonical
 * `COLOR_FAMILIES` order. Unknown values are dropped (a stale or hand-edited URL should not
 * break the page; the API itself answers 400 for unknown families). `gray` is read as `grey`.
 */
export function parseColorFamilyParam(value: string | null | undefined): ColorFamily[] {
  if (!value) return [];
  const requested = new Set<string>(
    value
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .map((part) => (part === "gray" ? "grey" : part))
      .filter(isColorFamily)
  );
  return COLOR_FAMILIES.filter((family) => requested.has(family));
}

/** Serialize families for the URL / API (`red,pink`), or "" when none are selected. */
export function serializeColorFamilies(families: readonly ColorFamily[]): string {
  return parseColorFamilyParam(families.join(",")).join(",");
}

/** Add or remove `family`, keeping canonical order. */
export function toggleColorFamily(families: readonly ColorFamily[], family: ColorFamily): ColorFamily[] {
  const next = new Set(families);
  if (next.has(family)) {
    next.delete(family);
  } else {
    next.add(family);
  }
  return COLOR_FAMILIES.filter((candidate) => next.has(candidate));
}

/** CSS background for a family chip swatch: a solid color, or a shifting gradient for multichrome. */
export function colorFamilySwatchBackground(family: ColorFamily, swatchHex: string): string {
  if (family === "multichrome") {
    return "conic-gradient(from 200deg, #2bd2c8, #3d6bff, #a23cff, #ff3d9a, #ffb23d, #2bd2c8)";
  }
  return swatchHex;
}
