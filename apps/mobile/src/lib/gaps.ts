/**
 * Gaps screen (web: `/polishes/gaps`): pure helpers over the shared gap rules
 * (`analyzeCollectionGaps` & co. in swatchwatch-shared `color/gaps.ts`, the same cells the web
 * draws and "Pick for me" weights by). Only owned color polishes count (D23).
 */
import {
  analyzeCollectionGaps,
  GAP_HUE_META,
  GAP_LIGHTNESS_META,
  gapCellKey,
  gapCellToSeedHex,
  HUE_FAMILY_ORDER,
  LIGHTNESS_BAND_ORDER,
  recommendGapCells,
  resolveDisplayHex,
  resolveProductCategory,
  type CollectionGapAnalysis,
  type CollectionGapCell,
  type Polish,
} from "swatchwatch-shared";
import { hexRouteParam } from "./goes-with";
import { isOwnedPolish } from "./status";

/** Same threshold as the web's getting-started checklist: fewer owned colors → explain, not a map. */
export const GAPS_MIN_OWNED = 5;

/** Most "Next buys" listed (as on the web). */
export const NEXT_BUYS_LIMIT = 6;

export type GapSeverity = "missing" | "thin" | "healthy";

export interface GapGridCell {
  key: string;
  hueLabel: string;
  lightnessLabel: string;
  count: number;
  severity: GapSeverity;
  /** Representative `#RRGGBB` of the cell: swatch tint and the By color seed. */
  seedHex: string;
  /** Tint opacity: missing cells faint, thin cells medium, healthy ones scale with density. */
  tintOpacity: number;
}

export interface GapNextBuy extends GapGridCell {
  /** `/search?hex=…` target for "Find in catalog". */
  searchHref: { pathname: "/search"; params: { hex: string } };
}

export interface GapsModel {
  /** Distinct valid display hexes of the owned color polishes (the web de-duplicates the same way). */
  hexCount: number;
  /** Grid rows, dark → light, each with one cell per hue family (`HUE_FAMILY_ORDER`). */
  rows: { lightnessLabel: string; cells: GapGridCell[] }[];
  missingCount: number;
  thinCount: number;
  nextBuys: GapNextBuy[];
}

/** Distinct, upper-cased display hexes of the owned color polishes. */
export function ownedColorHexes(polishes: readonly Polish[]): string[] {
  const seen = new Set<string>();
  for (const polish of polishes) {
    if (!isOwnedPolish(polish) || resolveProductCategory(polish.productCategory) !== "color") continue;
    const hex = resolveDisplayHex(polish)?.toUpperCase();
    if (hex && /^#[0-9A-F]{6}$/.test(hex)) seen.add(hex);
  }
  return [...seen];
}

export function gapSeverity(cell: CollectionGapCell, analysis: CollectionGapAnalysis): GapSeverity {
  const key = gapCellKey(cell);
  if (analysis.missing.some((c) => gapCellKey(c) === key)) return "missing";
  if (analysis.underrepresented.some((c) => gapCellKey(c) === key)) return "thin";
  return "healthy";
}

function toGridCell(cell: CollectionGapCell, severity: GapSeverity, maxCount: number): GapGridCell {
  const density = maxCount > 0 ? cell.count / maxCount : 0;
  return {
    key: gapCellKey(cell),
    hueLabel: GAP_HUE_META[cell.hueFamily].label,
    lightnessLabel: GAP_LIGHTNESS_META[cell.lightnessBand].label,
    count: cell.count,
    severity,
    seedHex: gapCellToSeedHex(cell.hueFamily, cell.lightnessBand),
    tintOpacity: severity === "missing" ? 0.18 : severity === "thin" ? 0.55 : 0.7 + 0.3 * density,
  };
}

/** The heatmap model (grid, counts, next buys) for a list of display hexes. */
export function buildGapsModel(hexes: readonly string[]): GapsModel {
  const analysis = analyzeCollectionGaps(hexes);
  const maxCount = analysis.cells.reduce((max, cell) => Math.max(max, cell.count), 0);
  const byKey = new Map(analysis.cells.map((cell) => [gapCellKey(cell), cell]));
  const grid = (cell: CollectionGapCell) => toGridCell(cell, gapSeverity(cell, analysis), maxCount);

  const rows = LIGHTNESS_BAND_ORDER.map((lightnessBand) => ({
    lightnessLabel: GAP_LIGHTNESS_META[lightnessBand].label,
    cells: HUE_FAMILY_ORDER.map((hueFamily) => grid(byKey.get(gapCellKey({ hueFamily, lightnessBand }))!)),
  }));

  return {
    hexCount: hexes.length,
    rows,
    missingCount: analysis.missing.length,
    thinCount: analysis.underrepresented.length,
    nextBuys: recommendGapCells(analysis, NEXT_BUYS_LIMIT).map((cell) => {
      const item = grid(cell);
      return { ...item, searchHref: { pathname: "/search" as const, params: { hex: hexRouteParam(item.seedHex) } } };
    }),
  };
}
