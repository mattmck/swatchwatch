/**
 * Search tab "By color" (#384): pure helpers behind the hue strip, lightness steps and the
 * ranked results. Mirrors the web `/polishes/search` behaviour (OKLAB distance with the shared
 * `colorDistance`, color polishes only, D23) without its canvas color wheel.
 */
import {
  colorDistance,
  colorSearchConfidence,
  compareColorSearchRank,
  isEstimatedDisplayHex,
  oklabToHex,
  resolveDisplayHex,
  resolveProductCategory,
  type ColorFamily,
  type MatchConfidence,
  type Polish,
  type PolishFilters,
} from "swatchwatch-shared";

/** 12 hue stops around the OKLCH wheel (degrees). */
export const HUE_STOPS = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330] as const;

/** OKLCH lightness of each lightness step, dark → light. */
export const LIGHTNESS_STEPS = [0.35, 0.5, 0.62, 0.74, 0.86] as const;

/** Chroma of the picker colors; `null` hue = the neutral stop. */
export const PICKER_CHROMA = 0.13;
const NEUTRAL_CHROMA = 0.015;

/** Default lightness step (mid). */
export const DEFAULT_LIGHTNESS_INDEX = 2;

/** Below this many owned color polishes the catalog is shown too, with a hint. */
export const COLLECTION_FALLBACK_MIN = 10;

/** Most ranked rows shown. */
export const COLOR_RESULT_LIMIT = 40;

/**
 * Catalog rows fetched per query. The server already ranks the whole catalog (`?nearHex=`), so
 * this only needs the shown rows plus the owned ones the collection fallback drops (fewer than
 * `COLLECTION_FALLBACK_MIN`).
 */
export const CATALOG_FETCH_SIZE = COLOR_RESULT_LIMIT + COLLECTION_FALLBACK_MIN;

const HEX_RE = /^#[0-9A-F]{6}$/;

/** The picker color for a hue stop (`null` = neutral) at a lightness step, as `#RRGGBB`. */
export function pickerHex(hue: number | null, lightnessIndex: number): string {
  const L = LIGHTNESS_STEPS[Math.max(0, Math.min(LIGHTNESS_STEPS.length - 1, lightnessIndex))];
  const C = hue === null ? NEUTRAL_CHROMA : PICKER_CHROMA;
  const rad = ((hue ?? 60) * Math.PI) / 180;
  return oklabToHex({ L, a: C * Math.cos(rad), b: C * Math.sin(rad) });
}

/** Normalize a `hex` route param (`C0392B`, `#c0392b`) to `#RRGGBB`, or null when invalid. */
export function normalizeHexParam(value: string | string[] | undefined | null): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return null;
  const hex = `#${raw.trim().replace(/^#/, "").toUpperCase()}`;
  return HEX_RE.test(hex) ? hex : null;
}

/** The polish's display hex (vendor > detected > name) when it is a valid `#RRGGBB`. */
export function polishHex(polish: Pick<Polish, "vendorHex" | "detectedHex" | "nameHex">): string | null {
  const hex = resolveDisplayHex(polish)?.toUpperCase();
  return hex && HEX_RE.test(hex) ? hex : null;
}

export interface ColorMatch {
  polish: Polish;
  hex: string;
  distance: number;
  /** The hex is only a guess from the color name (`isEstimatedDisplayHex`). */
  estimated: boolean;
  /** The dupe rule's color grade: high ≤ 0.05, medium ≤ 0.10, else low; always low when estimated. */
  grade: MatchConfidence;
}

/**
 * Color polishes with a usable hex: measured hexes before estimated name-only ones, nearest to
 * `targetHex` first within each (ties by brand, then name), like the server's `?nearHex=` order.
 * Other product categories (toppers, coats, …) never appear (D23).
 */
export function rankByColor(polishes: readonly Polish[], targetHex: string, limit = COLOR_RESULT_LIMIT): ColorMatch[] {
  const seen = new Set<string>();
  const matches: ColorMatch[] = [];
  for (const polish of polishes) {
    if (seen.has(polish.id) || resolveProductCategory(polish.productCategory) !== "color") continue;
    const hex = polishHex(polish);
    if (!hex) continue;
    seen.add(polish.id);
    const distance = colorDistance(hex, targetHex);
    const estimated = isEstimatedDisplayHex(polish);
    matches.push({ polish, hex, distance, estimated, grade: colorSearchConfidence(distance, estimated) });
  }
  matches.sort(
    (a, b) =>
      compareColorSearchRank(a, b) ||
      a.polish.brand.localeCompare(b.polish.brand) ||
      a.polish.name.localeCompare(b.polish.name),
  );
  return matches.slice(0, limit);
}

/**
 * The catalog query for a picked color: the nearest color polishes in the whole catalog,
 * ranked on the server (`?nearHex=`), limited to the selected family chips when there are any.
 */
export function catalogColorQuery(
  targetHex: string,
  families: readonly ColorFamily[],
): Pick<PolishFilters, "families" | "nearHex" | "pageSize"> {
  return { families: [...families], nearHex: [targetHex], pageSize: CATALOG_FETCH_SIZE };
}

/** Toggle a family chip. */
export function toggleFamily(selected: readonly ColorFamily[], family: ColorFamily): ColorFamily[] {
  return selected.includes(family) ? selected.filter((f) => f !== family) : [...selected, family];
}

/** Label for a grade chip; null for low (no chip). */
export function gradeLabel(grade: MatchConfidence): string | null {
  return grade === "high" ? "HIGH" : grade === "medium" ? "MEDIUM" : null;
}
