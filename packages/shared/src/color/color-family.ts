import { resolveDisplayHex, type Polish } from "../types/polish";
import { hexToOklab } from "./oklab";
import { normalizeHexColor } from "./hex-reconciliation";

/**
 * Color families: a coarse, human vocabulary over the continuous OKLAB space,
 * used to filter the collection and the catalog ("show me my greens").
 *
 * A shade's family is derived from its display hex (`resolveDisplayHex`:
 * vendor > detected > name) by binning OKLCH (OKLAB in polar form) lightness,
 * chroma and hue. `multichrome` is the exception: it comes from finish data
 * (a color-shifting finish has no single hue), not from the hex.
 *
 * The same bins run in Postgres as `shade_color_family()` (migration
 * 20261017061637910_add-shade-color-family), which keeps the generated
 * `shade.color_family` column current. Any change to the thresholds or the
 * decision order below MUST ship with a new migration that redefines that
 * function and recomputes the column; `packages/functions/tests/color-family.unit.test.cjs`
 * fails when the TS and SQL thresholds drift apart.
 */
export const COLOR_FAMILIES = [
  "red",
  "pink",
  "coral",
  "orange",
  "yellow",
  "green",
  "teal",
  "blue",
  "purple",
  "nude",
  "brown",
  "grey",
  "black",
  "white",
  "multichrome",
] as const;

/** A color family (see `COLOR_FAMILIES`). */
export type ColorFamily = (typeof COLOR_FAMILIES)[number];

/** Families a single hex can produce (everything except finish-driven `multichrome`). */
export type HexColorFamily = Exclude<ColorFamily, "multichrome">;

const COLOR_FAMILY_SET: ReadonlySet<string> = new Set(COLOR_FAMILIES);

/** True when `value` is exactly one of `COLOR_FAMILIES` (case-sensitive). */
export function isColorFamily(value: unknown): value is ColorFamily {
  return typeof value === "string" && COLOR_FAMILY_SET.has(value);
}

/** Display labels for UI chips and menus. */
export const COLOR_FAMILY_LABELS: Record<ColorFamily, string> = {
  red: "Red",
  pink: "Pink",
  coral: "Coral",
  orange: "Orange",
  yellow: "Yellow",
  green: "Green",
  teal: "Teal",
  blue: "Blue",
  purple: "Purple",
  nude: "Nude",
  brown: "Brown",
  grey: "Grey",
  black: "Black",
  white: "White",
  multichrome: "Multichrome",
};

/**
 * Representative swatch hex for each family (UI chips). Each one classifies
 * into its own family; `multichrome` has no single color, so UIs should render
 * it as a gradient and use this only as a fallback.
 */
export const COLOR_FAMILY_SWATCH_HEX: Record<ColorFamily, string> = {
  red: "#C8102E",
  pink: "#F06BA8",
  coral: "#FF7F61",
  orange: "#F28500",
  yellow: "#F5C518",
  green: "#2E8B57",
  teal: "#0A9396",
  blue: "#2F5BD3",
  purple: "#7B3FA0",
  nude: "#E3BC9A",
  brown: "#7B4A2D",
  grey: "#9A9A9A",
  black: "#141414",
  white: "#F7F7F7",
  multichrome: "#6A5ACD",
};

/**
 * Finish names that make a shade `multichrome` regardless of its hex. Compared
 * lowercased and trimmed against `finishes` and the legacy `finish`.
 * `multichrome` is the canonical finish; the rest are raw spellings that can
 * reach the legacy column before finish normalization. `duochrome` is
 * deliberately excluded: a duochrome has a dominant base color and is binned
 * by its hex.
 */
export const MULTICHROME_FAMILY_FINISHES = [
  "multichrome",
  "chameleon",
  "colorshift",
  "color shift",
  "color-shift",
] as const;

const MULTICHROME_FINISH_SET: ReadonlySet<string> = new Set(MULTICHROME_FAMILY_FINISHES);

/**
 * OKLCH bin thresholds. L is OKLAB lightness (0–1), C is chroma
 * (sqrt(a² + b²); pure grays are 0, sRGB tops out near 0.32), h is hue in
 * degrees [0, 360). Hue anchors for orientation: red ≈ 29, orange ≈ 70,
 * yellow ≈ 110, green ≈ 142, cyan ≈ 195, blue ≈ 264, magenta ≈ 328.
 *
 * Mirrored by name (camelCase ↔ snake_case) as `CONSTANT`s in
 * `shade_color_family_from_hex()` in the migration; a unit test compares them.
 */
export const COLOR_FAMILY_THRESHOLDS = {
  /** Below this chroma a color is achromatic: black / grey / white by lightness. */
  neutralMaxChroma: 0.03,
  /** Achromatic and darker than this → black (charcoal ≈ 0.38 stays grey). */
  blackMaxLightness: 0.3,
  /** Anything darker than this with chroma below `darkBlackMaxChroma` reads as black. */
  darkBlackMaxLightness: 0.2,
  darkBlackMaxChroma: 0.06,
  /** Achromatic and lighter than this → white (silver ≈ 0.81, platinum ≈ 0.919 stay grey). */
  whiteMinLightness: 0.92,
  /** Very light tints (cream, ivory, beige) → white. */
  paleWhiteMinLightness: 0.96,
  paleWhiteMaxChroma: 0.06,
  /** Nude: light, low-chroma, warm hues (peach, tan, beige, blush-beige). */
  nudeMinHue: 20,
  nudeMaxHue: 100,
  nudeMinLightness: 0.7,
  nudeMaxChroma: 0.1,
  /** Brown: darker warm hues with modest chroma (below nude lightness). */
  brownMinHue: 30,
  brownMaxHue: 100,
  brownMaxLightness: 0.7,
  brownMaxChroma: 0.13,
  /** ...plus very dark warm colors of any chroma, from this hue up (darker reds stay red). */
  brownDarkMinHue: 36,
  brownDarkMaxLightness: 0.45,
  /** Pink band wraps 340 → 360 → 20 (`redMinHue`). */
  pinkMinHue: 340,
  /** Pink-band colors darker than this are red (wine, burgundy) or purple (eggplant, below `berrySplitHue`). */
  darkPinkMaxLightness: 0.5,
  berrySplitHue: 350,
  /** 20–45: coral when light, else red (below `redOrangeSplitHue`) or orange. */
  redMinHue: 20,
  coralMinLightness: 0.68,
  redOrangeSplitHue: 36,
  orangeMinHue: 45,
  /** 80–115: yellow; dark ones are brown (below `oliveSplitHue`) or olive green. */
  yellowMinHue: 80,
  oliveMaxLightness: 0.62,
  oliveSplitHue: 100,
  greenMinHue: 115,
  tealMinHue: 170,
  blueMinHue: 205,
  purpleMinHue: 290,
  /** 320–340: pink when light and saturated (fuchsia, orchid), else purple (plum, lilac). */
  magentaMinHue: 320,
  magentaPinkMinLightness: 0.6,
  magentaPinkMinChroma: 0.1,
} as const;

/** OKLCH (polar OKLAB) coordinates: L 0–1, C ≥ 0, h in degrees [0, 360). */
export interface OKLch {
  L: number;
  C: number;
  h: number;
}

/**
 * Convert a 6-digit hex to OKLCH. Chroma uses `sqrt(a*a + b*b)` and hue
 * `atan2(b, a) * 180 / π` (not `Math.hypot` / a separate degrees helper) so
 * the arithmetic matches the Postgres function operation for operation.
 */
export function hexToOklch(hex: string): OKLch {
  const { L, a, b } = hexToOklab(hex);
  const C = Math.sqrt(a * a + b * b);
  let h = (Math.atan2(b, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { L, C, h };
}

/** Bin OKLCH coordinates into a hex color family. Pure; see `COLOR_FAMILY_THRESHOLDS`. */
export function classifyOklchColorFamily({ L, C, h }: OKLch): HexColorFamily {
  const t = COLOR_FAMILY_THRESHOLDS;

  // Achromatic / near-achromatic.
  if (C < t.neutralMaxChroma) {
    if (L < t.blackMaxLightness) return "black";
    if (L >= t.whiteMinLightness) return "white";
    return "grey";
  }
  if (L < t.darkBlackMaxLightness && C < t.darkBlackMaxChroma) return "black";
  if (L >= t.paleWhiteMinLightness && C < t.paleWhiteMaxChroma) return "white";

  // Low-chroma warm colors: nude (light) and brown (dark).
  if (h >= t.nudeMinHue && h < t.nudeMaxHue && L >= t.nudeMinLightness && C <= t.nudeMaxChroma) {
    return "nude";
  }
  if (
    h >= t.brownMinHue &&
    h < t.brownMaxHue &&
    L < t.brownMaxLightness &&
    (C <= t.brownMaxChroma || (h >= t.brownDarkMinHue && L < t.brownDarkMaxLightness))
  ) {
    return "brown";
  }

  // Hue bands.
  if (h >= t.pinkMinHue || h < t.redMinHue) {
    if (L < t.darkPinkMaxLightness) {
      return h >= t.pinkMinHue && h < t.berrySplitHue ? "purple" : "red";
    }
    return "pink";
  }
  if (h < t.orangeMinHue) {
    if (L >= t.coralMinLightness) return "coral";
    return h < t.redOrangeSplitHue ? "red" : "orange";
  }
  if (h < t.yellowMinHue) return "orange";
  if (h < t.greenMinHue) {
    if (L < t.oliveMaxLightness) return h < t.oliveSplitHue ? "brown" : "green";
    return "yellow";
  }
  if (h < t.tealMinHue) return "green";
  if (h < t.blueMinHue) return "teal";
  if (h < t.purpleMinHue) return "blue";
  if (h < t.magentaMinHue) return "purple";
  // 320–340
  return L >= t.magentaPinkMinLightness && C >= t.magentaPinkMinChroma ? "pink" : "purple";
}

/**
 * Color family of a single hex (`#RRGGBB` or `RRGGBB`), or null when it is not
 * a valid 6-digit hex. Never returns `multichrome` (that needs finish data).
 */
export function classifyHexColorFamily(hex: string | null | undefined): HexColorFamily | null {
  const normalized = normalizeHexColor(hex);
  if (!normalized) return null;
  return classifyOklchColorFamily(hexToOklch(normalized));
}

/** True when any of the finishes (or the legacy single finish) is a color-shifting finish. */
export function hasMultichromeFinish(
  polish: { finish?: string | null; finishes?: readonly string[] | null }
): boolean {
  const values = [...(polish.finishes ?? []), polish.finish];
  return values.some(
    (value) => typeof value === "string" && MULTICHROME_FINISH_SET.has(value.trim().toLowerCase())
  );
}

type ClassifiablePolish = Pick<Polish, "vendorHex" | "detectedHex" | "nameHex"> & {
  finish?: string | null;
  finishes?: readonly string[] | null;
};

/**
 * Color family of a shade: `multichrome` when it has a color-shifting finish,
 * otherwise the family of its display hex (`resolveDisplayHex`: vendor >
 * detected > name). Null when there is no multichrome finish and the display
 * hex is missing or not a valid 6-digit hex. Mirrors Postgres
 * `shade_color_family()` / the generated `shade.color_family` column.
 */
export function classifyColorFamily(polish: ClassifiablePolish): ColorFamily | null {
  if (hasMultichromeFinish(polish)) return "multichrome";
  return classifyHexColorFamily(resolveDisplayHex(polish));
}
