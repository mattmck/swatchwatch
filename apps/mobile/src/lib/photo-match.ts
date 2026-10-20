/**
 * Match to Collection helpers (#105, parity with the web's `lib/photo-match.ts` after #373).
 * Pure functions only, unit-tested directly.
 *
 * The API returns the palette plus each color's own top matches (`colorMatches`). Which colors
 * take part is decided here, so tapping a chip never re-uploads the photo:
 * - background (`light` / `dark`) and `skin` colors are hidden by default, unless the whole
 *   palette is such colors (a nude polish on white must still match);
 * - "Show all colors" brings the hidden ones back;
 * - tapping a chip flips it: an active chip is dropped, a hidden or dropped one comes back.
 */
import {
  classifyPaletteColor,
  type ColorMatchGroup,
  type ExtractedColor,
  type MatchConfidence,
  type MatchScope,
  type PaletteColorKind,
  type PolishImageMatchResponse,
  type PolishMatch,
} from "swatchwatch-shared";

/** Uppercase `#RRGGBB` (input with or without `#`), or null when not a 6-digit hex. */
export function normalizePaletteHex(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  return match ? `#${match[1].toUpperCase()}` : null;
}

export function paletteColorKind(color: Pick<ExtractedColor, "hex" | "kind">): PaletteColorKind {
  return color.kind ?? classifyPaletteColor(color.hex);
}

export const PALETTE_KIND_LABELS: Record<PaletteColorKind, string> = {
  color: "Color",
  light: "Background",
  dark: "Shadow",
  skin: "Skin tone",
};

export interface PaletteSelection {
  showAll: boolean;
  /** Uppercase hexes removed from matching. */
  drop: readonly string[];
  /** Uppercase hexes of default-hidden colors added back one by one. */
  keep: readonly string[];
}

export const DEFAULT_PALETTE_SELECTION: PaletteSelection = { showAll: false, drop: [], keep: [] };

export type PaletteChipState = "active" | "dropped" | "hidden";

export function isHiddenByDefault(color: ExtractedColor, palette: readonly ExtractedColor[]): boolean {
  if (paletteColorKind(color) === "color") return false;
  return palette.some((entry) => paletteColorKind(entry) === "color");
}

export function paletteChipState(
  color: ExtractedColor,
  palette: readonly ExtractedColor[],
  selection: PaletteSelection,
): PaletteChipState {
  const hex = normalizePaletteHex(color.hex) ?? color.hex;
  if (selection.drop.includes(hex)) return "dropped";
  if (isHiddenByDefault(color, palette) && !selection.showAll && !selection.keep.includes(hex)) return "hidden";
  return "active";
}

export function activePaletteColors(palette: readonly ExtractedColor[], selection: PaletteSelection): ExtractedColor[] {
  return palette.filter((color) => paletteChipState(color, palette, selection) === "active");
}

export function hiddenByDefaultCount(palette: readonly ExtractedColor[], selection: PaletteSelection): number {
  return palette.filter((color) => paletteChipState(color, palette, selection) === "hidden").length;
}

/** Flip one chip in or out of matching. */
export function togglePaletteColor(
  hexInput: string,
  palette: readonly ExtractedColor[],
  selection: PaletteSelection,
): PaletteSelection {
  const hex = normalizePaletteHex(hexInput);
  const color = hex ? palette.find((entry) => normalizePaletteHex(entry.hex) === hex) : undefined;
  if (!hex || !color) return selection;
  const state = paletteChipState(color, palette, selection);
  const without = (list: readonly string[]) => list.filter((entry) => entry !== hex);
  if (state === "active") return { ...selection, drop: [...without(selection.drop), hex], keep: without(selection.keep) };
  if (state === "dropped") {
    const next: PaletteSelection = { ...selection, drop: without(selection.drop) };
    // Coming back from "dropped" must not land in "hidden": keep it explicitly.
    if (isHiddenByDefault(color, palette) && !selection.showAll) return { ...next, keep: [...without(selection.keep), hex] };
    return next;
  }
  return { ...selection, keep: [...without(selection.keep), hex] };
}

/**
 * Per-color groups for the active colors, in palette order. Older API responses without
 * `colorMatches` are grouped from the flat `matches` list by `matchedColor`.
 */
export function activeColorGroups(
  response: Pick<PolishImageMatchResponse, "matches"> & { colorMatches?: readonly ColorMatchGroup[] },
  active: readonly ExtractedColor[],
): ColorMatchGroup[] {
  const groups: readonly ColorMatchGroup[] =
    response.colorMatches && response.colorMatches.length > 0
      ? response.colorMatches
      : active.map((color) => ({
          hex: color.hex,
          matches: response.matches.filter((m) => normalizePaletteHex(m.matchedColor) === normalizePaletteHex(color.hex)),
        }));
  const byHex = new Map(groups.map((group) => [normalizePaletteHex(group.hex), group]));
  return active.flatMap((color) => {
    const group = byHex.get(normalizePaletteHex(color.hex));
    return group ? [group] : [];
  });
}

export const CONFIDENCE_LABELS: Record<MatchConfidence, string> = { high: "Close match", medium: "Similar", low: "Loose" };

/** OKLAB distance read as "0%"; same normalization as the web match page. */
export const MATCH_PERCENT_MAX_DISTANCE = 0.5;

export function matchPercent(distance: number): number {
  const normalized = Math.min(Math.max(distance, 0) / MATCH_PERCENT_MAX_DISTANCE, 1);
  return Math.round((1 - normalized) * 100);
}

/** 0–1 pixel share as a whole percent label (min "<1%"). */
export function formatFraction(fraction: number): string {
  const pct = Math.round(fraction * 100);
  return pct < 1 ? "<1%" : `${pct}%`;
}

export const MATCH_SCOPE_OPTIONS: readonly { value: MatchScope; label: string }[] = [
  { value: "owned", label: "My collection" },
  { value: "wishlist", label: "Wishlist" },
  { value: "catalog", label: "Whole catalog" },
];

/** Replace one polish in every group after a status change (Add / Wishlist on a match row). */
export function replaceMatchedPolish<T extends { matches: PolishMatch[] }>(
  groups: readonly T[],
  polish: PolishMatch["polish"],
): T[] {
  return groups.map((group) => ({
    ...group,
    matches: group.matches.map((m) => (m.polish.id === polish.id ? { ...m, polish } : m)),
  }));
}
