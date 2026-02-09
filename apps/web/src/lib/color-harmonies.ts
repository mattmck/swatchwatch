import { hexToOklch, oklchToHex, type OKLCH } from "./color-utils";

export const HARMONY_TYPES = [
  { value: "similar", label: "Similar" },
  { value: "complementary", label: "Complementary" },
  { value: "split-complementary", label: "Split Complementary" },
  { value: "analogous", label: "Analogous" },
  { value: "triadic", label: "Triadic" },
  { value: "tetradic", label: "Tetradic" },
  { value: "monochromatic", label: "Monochromatic" },
] as const;

export type HarmonyType = (typeof HARMONY_TYPES)[number]["value"];

function rotateHue(oklch: OKLCH, degrees: number): string {
  if (Number.isNaN(oklch.h)) return oklchToHex(oklch);
  return oklchToHex({ ...oklch, h: (oklch.h + degrees + 360) % 360 });
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
  const oklch = hexToOklch(sourceHex);

  switch (harmony) {
    case "similar":
      return [];
    case "complementary":
      return [rotateHue(oklch, 180)];
    case "split-complementary":
      return [rotateHue(oklch, 150), rotateHue(oklch, 210)];
    case "analogous":
      return [rotateHue(oklch, -30), rotateHue(oklch, 30)];
    case "triadic":
      return [rotateHue(oklch, 120), rotateHue(oklch, 240)];
    case "tetradic":
      return [rotateHue(oklch, 90), rotateHue(oklch, 180), rotateHue(oklch, 270)];
    case "monochromatic":
      return [
        oklchToHex({ ...oklch, L: Math.max(0, oklch.L - 0.25) }),
        oklchToHex({ ...oklch, L: Math.max(0, oklch.L - 0.12) }),
        oklchToHex({ ...oklch, L: Math.min(1, oklch.L + 0.12) }),
        oklchToHex({ ...oklch, L: Math.min(1, oklch.L + 0.25) }),
      ];
  }
}
