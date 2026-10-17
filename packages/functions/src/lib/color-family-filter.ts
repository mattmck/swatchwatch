import { COLOR_FAMILIES, isColorFamily, type ColorFamily } from "swatchwatch-shared";

/** Spellings accepted in `?family=` besides the canonical `COLOR_FAMILIES` names. */
const FAMILY_ALIASES: Record<string, ColorFamily> = {
  gray: "grey",
};

export type ColorFamilyFilterResult =
  | { ok: true; families: ColorFamily[] }
  | { ok: false; error: string; invalid: string[] };

/**
 * Parse the `family` query parameter shared by `GET /api/polishes` and
 * `GET /api/catalog/search`: comma-separated and/or repeated (`?family=red,pink`,
 * `?family=red&family=pink`), case-insensitive, `gray` accepted for `grey`.
 * Returns the deduplicated families in `COLOR_FAMILIES` order (stable cache keys),
 * an empty list when the parameter is absent/blank, or an error naming the unknown
 * values (callers answer 400 rather than silently ignoring a typo and returning
 * everything).
 */
export function parseColorFamilyFilter(searchParams: URLSearchParams): ColorFamilyFilterResult {
  const requested = new Set<ColorFamily>();
  const invalid: string[] = [];

  for (const raw of searchParams.getAll("family")) {
    for (const part of raw.split(",")) {
      const value = part.trim().toLowerCase();
      if (!value) continue;
      const family = FAMILY_ALIASES[value] ?? value;
      if (isColorFamily(family)) {
        requested.add(family);
      } else {
        invalid.push(part.trim());
      }
    }
  }

  if (invalid.length > 0) {
    return {
      ok: false,
      invalid,
      error: `Invalid color family: ${invalid.join(", ")}. Valid families: ${COLOR_FAMILIES.join(", ")}`,
    };
  }

  return { ok: true, families: COLOR_FAMILIES.filter((family) => requested.has(family)) };
}
