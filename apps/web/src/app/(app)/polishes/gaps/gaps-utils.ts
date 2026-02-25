import type { CollectionGapCell, HueFamily, LightnessBand } from "swatchwatch-shared";
import { gapCellToSeedHex, HUE_FAMILY_ORDER, LIGHTNESS_BAND_ORDER } from "@/lib/color-utils";

export type CellSeverity = "missing" | "thin" | "healthy";

export const HUE_META: Record<HueFamily, { label: string; hue: number | null }> = {
  reds: { label: "Reds", hue: 8 },
  "oranges-corals": { label: "Oranges/Corals", hue: 26 },
  "yellows-golds": { label: "Yellows/Golds", hue: 52 },
  greens: { label: "Greens", hue: 130 },
  "blues-teals": { label: "Blues/Teals", hue: 205 },
  "purples-violets": { label: "Purples/Violets", hue: 275 },
  "pinks-magentas": { label: "Pinks/Magentas", hue: 328 },
  neutrals: { label: "Neutrals", hue: null },
};

export const LIGHTNESS_META: Record<LightnessBand, { label: string; short: string }> = {
  dark: { label: "Dark", short: "D" },
  "dark-medium": { label: "Dark-Mid", short: "DM" },
  medium: { label: "Medium", short: "M" },
  "medium-light": { label: "Light-Mid", short: "LM" },
  light: { label: "Light", short: "L" },
};

const LIGHTNESS_BASE: Record<LightnessBand, number> = {
  dark: 28,
  "dark-medium": 42,
  medium: 56,
  "medium-light": 70,
  light: 84,
};

export const SEVERITY_META: Record<CellSeverity, { label: string; badgeClassName: string; description: string }> = {
  missing: {
    label: "Missing",
    badgeClassName: "border-rose-400/60 bg-rose-100/80 text-rose-800 dark:bg-rose-950/40 dark:text-rose-100",
    description: "No shades land in this bucket yet. This is a high-value target for variety.",
  },
  thin: {
    label: "Thin",
    badgeClassName: "border-amber-400/60 bg-amber-100/80 text-amber-800 dark:bg-amber-950/40 dark:text-amber-100",
    description: "You have a start here, but this area is still underrepresented.",
  },
  healthy: {
    label: "Healthy",
    badgeClassName: "border-brand-lilac/50",
    description: "Coverage here is healthy. Consider balancing other thin/missing areas first.",
  },
};

/**
 * Build a stable key for a hue/lightness cell.
 * @param cell Cell-like object with `hueFamily` and `lightnessBand`.
 * @returns Key in `hueFamily:lightnessBand` format. Never throws.
 */
export function cellKey(cell: Pick<CollectionGapCell, "hueFamily" | "lightnessBand">): string {
  return `${cell.hueFamily}:${cell.lightnessBand}`;
}

/**
 * Sort cells by fixed grid order: lightness row first, then hue column.
 * @param cells Cells to sort.
 * @returns New sorted array; input is not mutated. Unknown hue/band values are treated as index `0`.
 */
export function sortCellsByGridOrder(cells: CollectionGapCell[]): CollectionGapCell[] {
  const hueOrder = new Map(HUE_FAMILY_ORDER.map((hue, index) => [hue, index]));
  const lightnessOrder = new Map(LIGHTNESS_BAND_ORDER.map((band, index) => [band, index]));
  return [...cells].sort((a, b) => {
    const aBand = lightnessOrder.get(a.lightnessBand) ?? 0;
    const bBand = lightnessOrder.get(b.lightnessBand) ?? 0;
    if (aBand !== bBand) return aBand - bBand;
    return (hueOrder.get(a.hueFamily) ?? 0) - (hueOrder.get(b.hueFamily) ?? 0);
  });
}

/**
 * Resolve a cell severity from missing/thin membership.
 * @param cell Target cell.
 * @param missing Set of missing cell keys.
 * @param thin Set of thin/underrepresented cell keys.
 * @returns `"missing"`, `"thin"`, or `"healthy"`. Missing takes precedence when both sets contain the key.
 */
export function getSeverity(
  cell: CollectionGapCell,
  missing: Set<string>,
  thin: Set<string>,
): CellSeverity {
  const key = cellKey(cell);
  if (missing.has(key)) return "missing";
  if (thin.has(key)) return "thin";
  return "healthy";
}

/**
 * Build heatmap cell classes for severity and selection state.
 * @param severity Coverage severity.
 * @param isSelected Whether the cell is currently selected.
 * @returns Tailwind class string; always includes a selected ring when `isSelected` is true.
 */
export function getCellClasses(severity: CellSeverity, isSelected: boolean): string {
  const selectedRing = isSelected
    ? "ring-2 ring-brand-purple/70 ring-offset-1 ring-offset-background"
    : "";

  if (severity === "missing") {
    return `border-rose-400/65 bg-rose-100/80 text-rose-900 shadow-[0_10px_28px_rgba(244,63,94,0.2)] dark:bg-rose-950/40 dark:text-rose-100 ${selectedRing}`;
  }

  if (severity === "thin") {
    return `border-amber-400/65 bg-amber-100/80 text-amber-900 shadow-[0_10px_28px_rgba(245,158,11,0.16)] dark:bg-amber-950/40 dark:text-amber-100 ${selectedRing}`;
  }

  return `border-brand-lilac/50 text-foreground/90 shadow-[0_8px_20px_rgba(66,16,126,0.08)] ${selectedRing}`;
}

/**
 * Build inline style for healthy cells so denser cells render visually heavier.
 * @param cell Heatmap cell.
 * @param maxCount Maximum count in the current analysis.
 * @returns Background color style object. If `maxCount <= 0`, intensity falls back to `0`.
 */
export function getHealthyCellStyle(cell: CollectionGapCell, maxCount: number): { backgroundColor: string } {
  const hue = HUE_META[cell.hueFamily].hue;
  const intensity = maxCount > 0 ? Math.min(cell.count / maxCount, 1) : 0;
  const baseLightness = LIGHTNESS_BASE[cell.lightnessBand];
  const lightness = Math.max(12, baseLightness - intensity * 8);
  const saturation = hue === null ? 8 : 76;

  return {
    backgroundColor: `hsl(${hue ?? 220} ${saturation}% ${lightness}%)`,
  };
}

/**
 * Build a search route for exploring similar colors from a gap seed color.
 * @param cell Gap cell to seed.
 * @returns `/polishes/search` URL with `color` (hex without `#`) and `harmony=similar`.
 */
export function getGapSearchHref(cell: CollectionGapCell): string {
  const params = new URLSearchParams({
    color: gapCellToSeedHex(cell.hueFamily, cell.lightnessBand).replace("#", ""),
    harmony: "similar",
  });
  return `/polishes/search?${params.toString()}`;
}

/**
 * Return up to `maxVisible` items for compact list rendering.
 * @param items Source items.
 * @param maxVisible Max count to return. Values <= 0 return an empty array.
 * @returns New array slice with at most `maxVisible` items.
 */
export function getVisibleItems<T>(items: readonly T[], maxVisible = 6): T[] {
  if (maxVisible <= 0) return [];
  return items.slice(0, maxVisible);
}

/**
 * Compute whether a list is truncated for UI summary text.
 * @param totalItems Total item count.
 * @param visibleItems Currently visible item count.
 * @returns `true` when there are hidden items (`totalItems > visibleItems`).
 */
export function shouldShowTruncationSummary(totalItems: number, visibleItems: number): boolean {
  return totalItems > visibleItems;
}

export type RowCellPresentation = {
  key: string;
  title: string;
  severity: CellSeverity;
  className: string;
  style: { backgroundColor: string } | undefined;
  count: number;
  lightnessShort: string;
  severityLabel: string;
};

/**
 * Build all row-cell presentation fields used by the heatmap `Row` component.
 * @param hueFamily Hue family for the cell column.
 * @param lightnessBand Lightness band for the row.
 * @param cellsByKey Cell lookup map.
 * @param maxCellCount Maximum cell count from analysis.
 * @param missingKeys Missing-key set.
 * @param thinKeys Thin-key set.
 * @param selectedCellKey Currently selected key.
 * @returns Render-ready cell data, or `null` when the key does not exist in `cellsByKey`.
 */
export function getRowCellPresentation({
  hueFamily,
  lightnessBand,
  cellsByKey,
  maxCellCount,
  missingKeys,
  thinKeys,
  selectedCellKey,
}: {
  hueFamily: HueFamily;
  lightnessBand: LightnessBand;
  cellsByKey: Map<string, CollectionGapCell>;
  maxCellCount: number;
  missingKeys: Set<string>;
  thinKeys: Set<string>;
  selectedCellKey: string | null;
}): RowCellPresentation | null {
  const key = `${hueFamily}:${lightnessBand}`;
  const cell = cellsByKey.get(key);
  if (!cell) return null;

  const severity = getSeverity(cell, missingKeys, thinKeys);
  const isSelected = selectedCellKey === key;
  const className = getCellClasses(severity, isSelected);
  const style = severity === "healthy" ? getHealthyCellStyle(cell, maxCellCount) : undefined;

  return {
    key,
    title: `${HUE_META[hueFamily].label} • ${LIGHTNESS_META[lightnessBand].label}: ${cell.count}`,
    severity,
    className,
    style,
    count: cell.count,
    lightnessShort: LIGHTNESS_META[lightnessBand].short,
    severityLabel: SEVERITY_META[severity].label,
  };
}
