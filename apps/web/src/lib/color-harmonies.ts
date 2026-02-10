import type {
  HarmonyType,
  PaletteHarmonyType,
  PaletteSuggestion,
} from "swatchwatch-shared";
import { colorDistance, hexToOklch, oklchToHex, type OKLCH } from "./color-utils";

export type { HarmonyType, PaletteSuggestion } from "swatchwatch-shared";

export const HARMONY_TYPES = [
  { value: "similar", label: "Similar" },
  { value: "complementary", label: "Complementary" },
  { value: "split-complementary", label: "Split Complementary" },
  { value: "analogous", label: "Analogous" },
  { value: "triadic", label: "Triadic" },
  { value: "tetradic", label: "Tetradic" },
  { value: "monochromatic", label: "Monochromatic" },
] as const satisfies ReadonlyArray<{ value: HarmonyType; label: string }>;

const DETECTABLE_HARMONIES: PaletteHarmonyType[] = [
  "complementary",
  "split-complementary",
  "analogous",
  "triadic",
  "tetradic",
  "monochromatic",
];

const SLOT_MATCH_THRESHOLD = 0.075;

function rotateHue(oklch: OKLCH, degrees: number): string {
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
 */
export function generateHarmonyPalette(
  sourceHex: string,
  harmony: HarmonyType,
): string[] {
  const source = sourceHex.toUpperCase();
  const oklch = hexToOklch(source);

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
export function generateHarmonyColors(
  sourceHex: string,
  harmony: HarmonyType,
): string[] {
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
