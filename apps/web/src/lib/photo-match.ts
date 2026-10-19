import type {
  ColorMatchGroup,
  ExtractedColor,
  MatchConfidence,
  MatchScope,
  PaletteColorKind,
  Polish,
  PolishImageMatchResponse,
  PolishMatch,
} from "swatchwatch-shared";
import { classifyPaletteColor } from "swatchwatch-shared";

/**
 * Photo match page helpers (#105). Pure functions only (no React, no fetch) so they are
 * unit-tested directly.
 *
 * The API returns the palette plus each color's own top matches (`colorMatches`). Which colors
 * take part in matching is decided here, on the client, so dropping or re-adding a chip never
 * re-uploads the photo:
 *
 * - Colors whose `kind` is `light` / `dark` (background) or `skin` are hidden by default, unless
 *   the whole palette is such colors (a photo of a nude polish on white must still match).
 * - "Show all colors" (`showAll`) brings the hidden kinds back.
 * - Tapping a chip flips it: an active chip goes into `drop`; a hidden one into `keep`.
 */

/** Uppercase `#RRGGBB` (input with or without `#`), or null when not a 6-digit hex. */
export function normalizePaletteHex(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  return match ? `#${match[1].toUpperCase()}` : null;
}

/** The color's palette kind: the API's `kind`, else classified locally (older API responses). */
export function paletteColorKind(color: Pick<ExtractedColor, "hex" | "kind">): PaletteColorKind {
  return color.kind ?? classifyPaletteColor(color.hex);
}

/** Short label for a hidden kind, shown on its chip. */
export const PALETTE_KIND_LABELS: Record<PaletteColorKind, string> = {
  color: "Color",
  light: "Background",
  dark: "Shadow",
  skin: "Skin tone",
};

export interface PaletteSelection {
  /** Show the background / skin colors that are hidden by default. */
  showAll: boolean;
  /** Uppercase hexes the user removed from matching. */
  drop: readonly string[];
  /** Uppercase hexes of default-hidden colors the user added back individually. */
  keep: readonly string[];
}

export const DEFAULT_PALETTE_SELECTION: PaletteSelection = { showAll: false, drop: [], keep: [] };

export type PaletteChipState =
  /** Used for matching. */
  | "active"
  /** Removed by the user. */
  | "dropped"
  /** Background or skin, hidden by default. */
  | "hidden";

/** True when `color` is hidden by default in this palette (see the module comment). */
export function isHiddenByDefault(color: ExtractedColor, palette: readonly ExtractedColor[]): boolean {
  if (paletteColorKind(color) === "color") return false;
  return palette.some((entry) => paletteColorKind(entry) === "color");
}

export function paletteChipState(
  color: ExtractedColor,
  palette: readonly ExtractedColor[],
  selection: PaletteSelection
): PaletteChipState {
  const hex = normalizePaletteHex(color.hex) ?? color.hex;
  if (selection.drop.includes(hex)) return "dropped";
  if (isHiddenByDefault(color, palette) && !selection.showAll && !selection.keep.includes(hex)) {
    return "hidden";
  }
  return "active";
}

/** Palette colors used for matching, in palette order. */
export function activePaletteColors(
  palette: readonly ExtractedColor[],
  selection: PaletteSelection
): ExtractedColor[] {
  return palette.filter((color) => paletteChipState(color, palette, selection) === "active");
}

/** How many colors are hidden by default right now (drives the "show all colors" link). */
export function hiddenByDefaultCount(palette: readonly ExtractedColor[], selection: PaletteSelection): number {
  return palette.filter((color) => paletteChipState(color, palette, selection) === "hidden").length;
}

/** Flip one chip in or out of matching. */
export function togglePaletteColor(
  hexInput: string,
  palette: readonly ExtractedColor[],
  selection: PaletteSelection
): PaletteSelection {
  const hex = normalizePaletteHex(hexInput);
  const color = hex ? palette.find((entry) => normalizePaletteHex(entry.hex) === hex) : undefined;
  if (!hex || !color) return selection;

  const state = paletteChipState(color, palette, selection);
  const without = (list: readonly string[]) => list.filter((entry) => entry !== hex);
  if (state === "active") {
    return { ...selection, drop: [...without(selection.drop), hex], keep: without(selection.keep) };
  }
  if (state === "dropped") {
    const next = { ...selection, drop: without(selection.drop) };
    // Coming back from "dropped" must not land in "hidden": keep it explicitly.
    if (isHiddenByDefault(color, palette) && !selection.showAll) {
      next.keep = [...without(selection.keep), hex];
    }
    return next;
  }
  return { ...selection, keep: [...without(selection.keep), hex] };
}

/** Per-color groups of the active colors, in palette order. */
export function activeColorGroups(
  groups: readonly ColorMatchGroup[],
  active: readonly ExtractedColor[]
): ColorMatchGroup[] {
  const byHex = new Map(groups.map((group) => [normalizePaletteHex(group.hex), group]));
  return active.flatMap((color) => {
    const group = byHex.get(normalizePaletteHex(color.hex));
    return group ? [group] : [];
  });
}

const CONFIDENCE_RANK: Record<MatchConfidence, number> = { high: 0, medium: 1, low: 2 };

/**
 * Flat ranking over the active colors (the "All matches" view).
 *
 * Each polish keeps its closest active color (min distance across the active groups; because
 * every group holds that color's own top N, the union contains the true top N). Sorting is
 * fraction-weighted: by confidence grade first, then by how much of the photo the matched color
 * covers, then by distance — so within "Close match", a polish matching the dominant color
 * comes before one matching a small accent.
 */
export function rankFlatMatches(
  groups: readonly ColorMatchGroup[],
  active: readonly ExtractedColor[],
  limit: number
): PolishMatch[] {
  const fractionByHex = new Map(active.map((color) => [normalizePaletteHex(color.hex), color.fraction]));
  const best = new Map<string, PolishMatch>();
  for (const group of activeColorGroups(groups, active)) {
    for (const match of group.matches) {
      const current = best.get(match.polish.id);
      if (!current || match.distance < current.distance) best.set(match.polish.id, match);
    }
  }
  const fraction = (match: PolishMatch) => fractionByHex.get(normalizePaletteHex(match.matchedColor)) ?? 0;
  return [...best.values()]
    .sort(
      (a, b) =>
        CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence] ||
        fraction(b) - fraction(a) ||
        a.distance - b.distance ||
        a.polish.brand.localeCompare(b.polish.brand) ||
        a.polish.name.localeCompare(b.polish.name)
    )
    .slice(0, Math.max(0, limit));
}

/** Number of matches per confidence grade. */
export function confidenceCounts(matches: readonly PolishMatch[]): Record<MatchConfidence, number> {
  const counts: Record<MatchConfidence, number> = { high: 0, medium: 0, low: 0 };
  for (const match of matches) counts[match.confidence] += 1;
  return counts;
}

export const MATCH_SCOPE_OPTIONS: ReadonlyArray<{ value: MatchScope; label: string; noun: string }> = [
  { value: "owned", label: "My collection", noun: "owned" },
  { value: "wishlist", label: "Wishlist", noun: "wishlisted" },
  { value: "catalog", label: "Whole catalog", noun: "catalog" },
];

export function matchScopeLabel(scope: MatchScope): string {
  return MATCH_SCOPE_OPTIONS.find((option) => option.value === scope)?.label ?? scope;
}

/**
 * Why there is nothing to show, for the empty state: no colors in the photo, no candidate
 * shades in this scope/filter at all, every chip dropped, or (only) loose matches.
 */
export type MatchEmptyReason = "no-colors" | "no-candidates" | "no-active-colors" | "only-loose" | null;

export function matchEmptyReason(input: {
  paletteSize: number;
  candidateCount: number;
  activeColorCount: number;
  matches: readonly PolishMatch[];
}): MatchEmptyReason {
  if (input.paletteSize === 0) return "no-colors";
  if (input.candidateCount === 0) return "no-candidates";
  if (input.activeColorCount === 0) return "no-active-colors";
  if (input.matches.length > 0 && input.matches.every((match) => match.confidence === "low")) return "only-loose";
  return null;
}

/**
 * Replace polish `id` in every list of a response (flat matches and each color group). With
 * `expected`, a row is only replaced while it is still that exact object, so an older request
 * settling cannot overwrite a newer optimistic change (same rule as `commitOptimistic`).
 */
export function replacePolishInResponse(
  response: PolishImageMatchResponse,
  id: string,
  next: Polish,
  expected?: Polish
): PolishImageMatchResponse {
  let changed = false;
  const patch = (list: PolishMatch[]) =>
    list.map((match) => {
      if (match.polish.id !== id || (expected && match.polish !== expected)) return match;
      changed = true;
      return { ...match, polish: next };
    });
  const matches = patch(response.matches);
  const colorMatches = response.colorMatches.map((group) => ({ ...group, matches: patch(group.matches) }));
  return changed ? { ...response, matches, colorMatches } : response;
}

/** The first copy of polish `id` in a response (all copies are the same object after a replace). */
export function findPolishInResponse(response: PolishImageMatchResponse, id: string): Polish | null {
  for (const match of response.matches) if (match.polish.id === id) return match.polish;
  for (const group of response.colorMatches) {
    for (const match of group.matches) if (match.polish.id === id) return match.polish;
  }
  return null;
}

/**
 * Hydrate a response so every copy of the same polish is one shared object (the API sends a
 * separate copy per list). Lets optimistic updates compare rows by identity.
 */
export function shareResponsePolishes(response: PolishImageMatchResponse): PolishImageMatchResponse {
  const byId = new Map<string, Polish>();
  const share = (list: PolishMatch[]) =>
    list.map((match) => {
      const existing = byId.get(match.polish.id);
      if (existing) return { ...match, polish: existing };
      byId.set(match.polish.id, match.polish);
      return match;
    });
  return {
    ...response,
    matches: share(response.matches),
    colorMatches: (response.colorMatches ?? []).map((group) => ({ ...group, matches: share(group.matches) })),
  };
}
