/**
 * Collection gap heatmap rules: bin display hexes into hue family × lightness band cells, find
 * missing / thin cells, order the "next buys" and seed a representative hex per cell. Moved from
 * the web's `color-utils.ts` / gaps page so the Expo app uses the same cells; `apps/web/src/lib/color-utils.ts`
 * re-exports the analysis pieces. Pure; depends only on shared OKLAB.
 */
import type { CollectionGapAnalysis, CollectionGapCell, HueFamily, LightnessBand } from "../types/palette";
import { hexToOklab, oklabToHex } from "./oklab";

export const HUE_FAMILY_ORDER: HueFamily[] = [
  "reds",
  "oranges-corals",
  "yellows-golds",
  "greens",
  "blues-teals",
  "purples-violets",
  "pinks-magentas",
  "neutrals",
];

export const LIGHTNESS_BAND_ORDER: LightnessBand[] = ["dark", "dark-medium", "medium", "medium-light", "light"];

/** Display labels per hue family; `hue` is the OKLCH seed hue (null = neutrals). */
export const GAP_HUE_META: Record<HueFamily, { label: string; hue: number | null }> = {
  reds: { label: "Reds", hue: 8 },
  "oranges-corals": { label: "Oranges/Corals", hue: 26 },
  "yellows-golds": { label: "Yellows/Golds", hue: 52 },
  greens: { label: "Greens", hue: 130 },
  "blues-teals": { label: "Blues/Teals", hue: 205 },
  "purples-violets": { label: "Purples/Violets", hue: 275 },
  "pinks-magentas": { label: "Pinks/Magentas", hue: 328 },
  neutrals: { label: "Neutrals", hue: null },
};

export const GAP_LIGHTNESS_META: Record<LightnessBand, { label: string; short: string }> = {
  dark: { label: "Dark", short: "D" },
  "dark-medium": { label: "Dark-Mid", short: "DM" },
  medium: { label: "Medium", short: "M" },
  "medium-light": { label: "Light-Mid", short: "LM" },
  light: { label: "Light", short: "L" },
};

const GAP_LIGHTNESS_SEED: Record<LightnessBand, number> = {
  dark: 0.24,
  "dark-medium": 0.38,
  medium: 0.52,
  "medium-light": 0.7,
  light: 0.86,
};

const HEX_RE = /^#[0-9A-Fa-f]{6}$/;

/** Stable `hueFamily:lightnessBand` key of a cell. */
export function gapCellKey(cell: Pick<CollectionGapCell, "hueFamily" | "lightnessBand">): string {
  return `${cell.hueFamily}:${cell.lightnessBand}`;
}

/** Parse a `hueFamily:lightnessBand` key; `null` for anything that is not a valid cell. */
export function parseGapCellKey(
  value: string | null | undefined,
): { hueFamily: HueFamily; lightnessBand: LightnessBand } | null {
  if (!value) return null;
  const [hueFamily, lightnessBand, ...rest] = value.split(":");
  if (rest.length > 0) return null;
  if (!(HUE_FAMILY_ORDER as string[]).includes(hueFamily)) return null;
  if (!(LIGHTNESS_BAND_ORDER as string[]).includes(lightnessBand)) return null;
  return { hueFamily: hueFamily as HueFamily, lightnessBand: lightnessBand as LightnessBand };
}

function classifyHueFamily(C: number, h: number): HueFamily {
  if (C < 0.04 || Number.isNaN(h)) return "neutrals";
  if (h >= 350 || h < 10) return "reds";
  if (h < 40) return "oranges-corals";
  if (h < 80) return "yellows-golds";
  if (h < 170) return "greens";
  if (h < 260) return "blues-teals";
  if (h < 310) return "purples-violets";
  return "pinks-magentas";
}

function classifyLightnessBand(L: number): LightnessBand {
  if (L < 0.3) return "dark";
  if (L < 0.44) return "dark-medium";
  if (L < 0.6) return "medium";
  if (L < 0.76) return "medium-light";
  return "light";
}

/** Heatmap cell of a `#RRGGBB` hex, or `null` for anything else. */
export function classifyHexToGapCell(hex: string): { hueFamily: HueFamily; lightnessBand: LightnessBand } | null {
  if (!HEX_RE.test(hex)) return null;
  const { L, a, b } = hexToOklab(hex);
  const C = Math.sqrt(a * a + b * b);
  const h = C < 1e-8 ? NaN : ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
  return { hueFamily: classifyHueFamily(C, h), lightnessBand: classifyLightnessBand(L) };
}

/** Representative `#RRGGBB` for a cell (OKLCH seeds, so it classifies back into the same cell). */
export function gapCellToSeedHex(hueFamily: HueFamily, lightnessBand: LightnessBand): string {
  const hue = GAP_HUE_META[hueFamily].hue;
  const L = GAP_LIGHTNESS_SEED[lightnessBand];
  const C = hue === null ? 0 : 0.09;
  const hRad = ((hue ?? 220) * Math.PI) / 180;
  return oklabToHex({ L, a: C * Math.cos(hRad), b: C * Math.sin(hRad) });
}

/** Hue/lightness coverage of the given hexes: all cells (grid order), missing and thin ones. */
export function analyzeCollectionGaps(hexColors: readonly string[]): CollectionGapAnalysis {
  const counts = new Map<string, number>();
  for (const hex of hexColors) {
    const cell = classifyHexToGapCell(hex);
    if (!cell) continue;
    const key = gapCellKey(cell);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const cells: CollectionGapCell[] = [];
  for (const hueFamily of HUE_FAMILY_ORDER) {
    for (const lightnessBand of LIGHTNESS_BAND_ORDER) {
      cells.push({ hueFamily, lightnessBand, count: counts.get(gapCellKey({ hueFamily, lightnessBand })) ?? 0 });
    }
  }

  const missing = cells.filter((cell) => cell.count === 0);
  const lowThreshold = Math.max(1, Math.floor((hexColors.length / Math.max(cells.length, 1)) * 0.5));
  const underrepresented = cells.filter((cell) => cell.count > 0 && cell.count <= lowThreshold);
  return { cells, missing, underrepresented };
}

/** Sort cells by grid order: lightness row first, then hue column (new array). */
export function sortGapCellsByGridOrder(cells: readonly CollectionGapCell[]): CollectionGapCell[] {
  const hueOrder = new Map(HUE_FAMILY_ORDER.map((hue, index) => [hue, index]));
  const lightnessOrder = new Map(LIGHTNESS_BAND_ORDER.map((band, index) => [band, index]));
  return [...cells].sort((a, b) => {
    const aBand = lightnessOrder.get(a.lightnessBand) ?? 0;
    const bBand = lightnessOrder.get(b.lightnessBand) ?? 0;
    if (aBand !== bBand) return aBand - bBand;
    return (hueOrder.get(a.hueFamily) ?? 0) - (hueOrder.get(b.hueFamily) ?? 0);
  });
}

/** "What to add next": missing cells in grid order, then thin cells emptiest first; at most `limit`. */
export function recommendGapCells(analysis: CollectionGapAnalysis, limit = 6): CollectionGapCell[] {
  const missingKeys = new Set(analysis.missing.map(gapCellKey));
  const prioritized = [
    ...sortGapCellsByGridOrder(analysis.missing),
    ...analysis.underrepresented.filter((cell) => !missingKeys.has(gapCellKey(cell))).sort((a, b) => a.count - b.count),
  ];
  return prioritized.slice(0, limit);
}
