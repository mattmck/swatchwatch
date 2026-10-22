/**
 * Color harmony rules (complementary, analogous, triadic, …) on the OKLCH hue wheel, shared by
 * the web app (`/polishes/search`, Pick for me, the marketing showcase) and the mobile app
 * (Search "By color", Pair it, polish detail "Goes with").
 *
 * Pure and dependency-free (no DOM): hue rotations happen in OKLCH and are gamut-mapped back to
 * sRGB by reducing chroma, so a rotated color keeps the source's lightness.
 */
import type { HarmonyType, PaletteHarmonyType, PaletteSuggestion } from "../types/palette";
import type { HarmonyType as ReferenceHarmonyType } from "../types/reference";
import { colorDistance, hexToOklab, oklabToRgb, rgbToHexString, type OKLab } from "./oklab";

/**
 * @deprecated Fallback-only harmony options. Prefer API-backed values (reference data).
 */
export const HARMONY_TYPES = [
  { value: "similar", label: "Similar" },
  { value: "complementary", label: "Complementary" },
  { value: "split-complementary", label: "Split Complementary" },
  { value: "analogous", label: "Analogous" },
  { value: "triadic", label: "Triadic" },
  { value: "tetradic", label: "Tetradic" },
  { value: "monochromatic", label: "Monochromatic" },
] as const satisfies ReadonlyArray<{ value: HarmonyType; label: string }>;

/**
 * Build harmony selector options from API reference data when available.
 * Falls back to `HARMONY_TYPES`, validates names against known `HarmonyType` values,
 * and preserves labels via `fallbackLabelByValue` when display names are missing.
 */
export function getHarmonyTypeOptions(
  harmonyTypes?: ReferenceHarmonyType[],
): ReadonlyArray<{ value: HarmonyType; label: string }> {
  if (!harmonyTypes || harmonyTypes.length === 0) {
    return HARMONY_TYPES;
  }

  const fallbackLabelByValue = new Map<HarmonyType, string>(
    HARMONY_TYPES.map((item) => [item.value, item.label]),
  );
  const validTypes = new Set<HarmonyType>(HARMONY_TYPES.map((item) => item.value));

  return harmonyTypes
    .filter((harmony): harmony is ReferenceHarmonyType & { name: HarmonyType } =>
      validTypes.has(harmony.name as HarmonyType)
    )
    .sort((a, b) => a.sortOrder - b.sortOrder || a.displayName.localeCompare(b.displayName))
    .map((harmony) => ({
      value: harmony.name,
      label: harmony.displayName || fallbackLabelByValue.get(harmony.name) || harmony.name,
    }));
}

// ── OKLCH helpers (private) ──────────────────────────────────
// Hue is NaN for achromatic colors so a gray never "rotates". This differs on purpose from
// `hexToOklch` in color-family.ts, which mirrors the Postgres classifier operation for operation.

interface HarmonyOklch {
  L: number;
  C: number;
  h: number;
}

function toOklch({ L, a, b }: OKLab): HarmonyOklch {
  const C = Math.sqrt(a * a + b * b);
  const h = C < 1e-8 ? NaN : ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
  return { L, C, h };
}

function toOklab({ L, C, h }: HarmonyOklch): OKLab {
  const hRad = Number.isNaN(h) ? 0 : (h * Math.PI) / 180;
  return { L, a: C * Math.cos(hRad), b: C * Math.sin(hRad) };
}

function isRgbInGamut(rgb: { r: number; g: number; b: number }): boolean {
  return rgb.r >= 0 && rgb.r <= 255 && rgb.g >= 0 && rgb.g <= 255 && rgb.b >= 0 && rgb.b <= 255;
}

/** Reduce chroma until the OKLCH color fits within sRGB gamut. */
function clampChromaToGamut(oklch: HarmonyOklch): HarmonyOklch {
  if (oklch.C < 1e-8) return { ...oklch, C: 0 };
  let lo = 0;
  let hi = oklch.C;
  let result = { ...oklch, C: 0 };
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    const candidate = { ...oklch, C: mid };
    if (isRgbInGamut(oklabToRgb(toOklab(candidate)))) {
      result = candidate;
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return result;
}

/** Lowercase `#rrggbb`, the same output as the web's `oklchToHex` in `color-utils.ts`. */
function oklchToHex(oklch: HarmonyOklch): string {
  return rgbToHexString(oklabToRgb(toOklab(clampChromaToGamut(oklch)))).toLowerCase();
}

const DETECTABLE_HARMONIES: PaletteHarmonyType[] = [
  "complementary",
  "split-complementary",
  "analogous",
  "triadic",
  "tetradic",
  "monochromatic",
];

const SLOT_MATCH_THRESHOLD = 0.075;

function rotateHue(oklch: HarmonyOklch, degrees: number): string {
  if (Number.isNaN(oklch.h)) return oklchToHex(oklch);
  return oklchToHex({ ...oklch, h: (oklch.h + degrees + 360) % 360 });
}

function normalizeHexes(hexes: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const hex of hexes) {
    const canonical = hex.toUpperCase();
    if (!/^#[0-9A-F]{6}$/.test(canonical)) continue;
    if (!seen.has(canonical)) {
      seen.add(canonical);
      normalized.push(canonical);
    }
  }
  return normalized;
}

/**
 * Generate a full palette (source + target slots) for a given source and harmony.
 * Index 0 is the uppercased source (`monochromatic` instead orders five steps dark → light with
 * the source in the middle); generated slots are lowercase `#rrggbb`.
 */
export function generateHarmonyPalette(sourceHex: string, harmony: HarmonyType): string[] {
  const source = sourceHex.toUpperCase();
  const oklch = toOklch(hexToOklab(source));

  switch (harmony) {
    case "similar":
      return [source];
    case "complementary":
      return [source, rotateHue(oklch, 180)];
    case "split-complementary":
      return [source, rotateHue(oklch, 150), rotateHue(oklch, 210)];
    case "analogous":
      return [source, rotateHue(oklch, -30), rotateHue(oklch, 30)];
    case "triadic":
      return [source, rotateHue(oklch, 120), rotateHue(oklch, 240)];
    case "tetradic":
      return [source, rotateHue(oklch, 90), rotateHue(oklch, 180), rotateHue(oklch, 270)];
    case "monochromatic":
      return [
        oklchToHex({ ...oklch, L: Math.max(0, oklch.L - 0.25) }),
        oklchToHex({ ...oklch, L: Math.max(0, oklch.L - 0.12) }),
        source,
        oklchToHex({ ...oklch, L: Math.min(1, oklch.L + 0.12) }),
        oklchToHex({ ...oklch, L: Math.min(1, oklch.L + 0.25) }),
      ];
  }
}

/**
 * Generate harmony target colors for a given source hex.
 * Returns an array of target hex values (does NOT include the source).
 * For "similar" mode, returns an empty array (source IS the target).
 */
export function generateHarmonyColors(sourceHex: string, harmony: HarmonyType): string[] {
  const palette = generateHarmonyPalette(sourceHex, harmony);
  return harmony === "similar" ? [] : palette.slice(1);
}

function evaluatePaletteFit(
  anchors: string[],
  targetHexes: string[],
): { score: number; completionHexes: string[] } {
  const slotMatches = new Array<boolean>(targetHexes.length).fill(false);

  for (let slotIndex = 0; slotIndex < targetHexes.length; slotIndex++) {
    const slotHex = targetHexes[slotIndex];
    slotMatches[slotIndex] = anchors.some(
      (anchorHex) => colorDistance(anchorHex, slotHex) <= SLOT_MATCH_THRESHOLD,
    );
  }

  const completionHexes = targetHexes.filter((_, i) => !slotMatches[i]);
  const coverage = slotMatches.filter(Boolean).length / targetHexes.length;

  let sumMinDistance = 0;
  for (const anchorHex of anchors) {
    let minDistance = Infinity;
    for (const targetHex of targetHexes) {
      const d = colorDistance(anchorHex, targetHex);
      if (d < minDistance) minDistance = d;
    }
    sumMinDistance += minDistance;
  }
  const avgMinDistance = sumMinDistance / anchors.length;
  const distanceScore = 1 - Math.min(avgMinDistance / 0.2, 1);

  return {
    score: coverage * 0.65 + distanceScore * 0.35,
    completionHexes,
  };
}

/**
 * Detect the best-fit harmony for 2+ anchor colors and return missing colors
 * needed to complete that palette.
 */
export function suggestPaletteCompletion(anchorHexes: string[]): PaletteSuggestion | null {
  const anchors = normalizeHexes(anchorHexes);
  if (anchors.length < 2) return null;

  let best:
    | {
        sourceHex: string;
        harmony: PaletteHarmonyType;
        targetHexes: string[];
        completionHexes: string[];
        score: number;
      }
    | null = null;

  for (const sourceHex of anchors) {
    for (const harmony of DETECTABLE_HARMONIES) {
      const targetHexes = generateHarmonyPalette(sourceHex, harmony);
      const { score, completionHexes } = evaluatePaletteFit(anchors, targetHexes);
      if (!best || score > best.score) {
        best = { sourceHex, harmony, targetHexes, completionHexes, score };
      }
    }
  }

  if (!best) return null;

  return {
    harmony: best.harmony,
    confidence: Number(Math.max(0, Math.min(1, best.score)).toFixed(2)),
    anchors,
    sourceHex: best.sourceHex,
    targetHexes: best.targetHexes,
    completionHexes: best.completionHexes,
  };
}
