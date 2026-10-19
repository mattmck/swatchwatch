import { hexToOklch } from "./color-family";
import { normalizeHexColor } from "./hex-reconciliation";

/**
 * Photo-palette quality (#105): which extracted colors are probably not what the user wants to
 * match. A photo of a mani or an outfit usually also contains a light or dark background
 * (paper, a wall, a black table) and skin; matching those against polishes mostly returns
 * whites, blacks and nudes the user did not ask for.
 *
 * - `light`: near-white, low-chroma (paper, walls, studio backgrounds).
 * - `dark`: near-black, low-chroma (shadows, black backgrounds).
 * - `skin`: the warm, low-to-medium chroma band human skin falls in, light to deep.
 * - `color`: everything else.
 *
 * The rule is deliberately coarse: a nude or tan polish also reads as `skin`, a white or black
 * polish as `light`/`dark`. That is why the web page only hides these by default and offers
 * "show all colors", and why the API never drops them unless asked (`excludeSkinTones`,
 * `excludeBackground`).
 */
export type PaletteColorKind = "color" | "light" | "dark" | "skin";

export const PALETTE_COLOR_KINDS: readonly PaletteColorKind[] = ["color", "light", "dark", "skin"];

/** OKLCH bounds for `classifyPaletteColor` (L 0–1, C ≥ 0, hue in degrees). */
export const PALETTE_QUALITY_THRESHOLDS = {
  /** At least this light and below `lightMaxChroma` → `light`. */
  lightMinLightness: 0.9,
  lightMaxChroma: 0.05,
  /** Any color at least this light reads as a washed-out background. */
  paleMinLightness: 0.97,
  /** Darker than this and below `darkMaxChroma` → `dark`. */
  darkMaxLightness: 0.22,
  darkMaxChroma: 0.06,
  /** Skin: warm hues (pinkish beige → golden tan)... */
  skinMinHue: 20,
  skinMaxHue: 80,
  /** ...with modest chroma (skin is never grey, and rarely as saturated as a polish)... */
  skinMinChroma: 0.025,
  skinMaxChroma: 0.14,
  /** ...from deep to fair skin. */
  skinMinLightness: 0.35,
  skinMaxLightness: 0.92,
} as const;

/** Kind of one extracted palette color; an invalid hex is `color` (never hidden). */
export function classifyPaletteColor(hex: string | null | undefined): PaletteColorKind {
  const normalized = normalizeHexColor(hex);
  if (!normalized) return "color";
  const t = PALETTE_QUALITY_THRESHOLDS;
  const { L, C, h } = hexToOklch(normalized);

  if (L >= t.paleMinLightness) return "light";
  if (L >= t.lightMinLightness && C < t.lightMaxChroma) return "light";
  if (L < t.darkMaxLightness && C < t.darkMaxChroma) return "dark";
  if (
    h >= t.skinMinHue &&
    h <= t.skinMaxHue &&
    C >= t.skinMinChroma &&
    C <= t.skinMaxChroma &&
    L >= t.skinMinLightness &&
    L <= t.skinMaxLightness
  ) {
    return "skin";
  }
  return "color";
}

/** True for the kinds that count as background (`light`, `dark`). */
export function isBackgroundPaletteKind(kind: PaletteColorKind): boolean {
  return kind === "light" || kind === "dark";
}

/**
 * Chroma-based vibrancy weight in [1, 2] for `preferVibrant`: grey = 1, a fully saturated
 * polish color (C ≥ 0.2) = 2. Multiplied with a color's pixel share when choosing which
 * colors make the palette.
 */
export function paletteVibrancyWeight(hex: string): number {
  const normalized = normalizeHexColor(hex);
  if (!normalized) return 1;
  const { C } = hexToOklch(normalized);
  return 1 + Math.min(C / 0.2, 1);
}
