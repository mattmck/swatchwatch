import type { HarmonyType } from "swatchwatch-shared";
import type { Undertone } from "@/lib/color-utils";

/**
 * URL state for `/polishes/search` (#348), same pattern as `polish-list-url.ts`: the page
 * writes its canonical query with `router.replace`, so browser back from a polish detail page
 * restores the selected color, harmony, wheel mode, filters, focused colors and locked target.
 *
 * `color` + `harmony` were already read from links (the gap map's "Explore seed color"); they
 * keep their names. Hover state, collapsed panels and feedback toasts stay in memory.
 */

export type ColorSearchHarmony = "all" | HarmonyType;
export type ColorSearchWheelMode = "free" | "snap";
export type ColorSearchHarmonyColorSet = "any" | "all" | "collection";
export type ColorSearchResultsScope = "all" | "collection";
export type ColorSearchAvailability = "all" | "owned" | "wishlist";

export interface ColorSearchUrlState {
  /** Selected wheel color (`#RRGGBB`, upper case), lightness included. */
  color: string | null;
  harmony: ColorSearchHarmony;
  wheelMode: ColorSearchWheelMode;
  harmonyColorSet: ColorSearchHarmonyColorSet;
  resultsScope: ColorSearchResultsScope;
  toneFilter: Undertone | "all";
  brandFilter: string;
  finishFilter: string;
  availabilityFilter: ColorSearchAvailability;
  /** Focused palette colors (`#RRGGBB`), at most `MAX_PALETTE_ANCHORS`. */
  paletteAnchors: string[];
  /** Locked (clicked) harmony target. */
  target: string | null;
  /** Applied recommended palette id (restored only if the page still recommends it). */
  paletteId: string | null;
}

export const MAX_PALETTE_ANCHORS = 8;

export const DEFAULT_COLOR_SEARCH_STATE: ColorSearchUrlState = {
  color: null,
  harmony: "all",
  wheelMode: "free",
  harmonyColorSet: "any",
  resultsScope: "all",
  toneFilter: "all",
  brandFilter: "all",
  finishFilter: "all",
  availabilityFilter: "all",
  paletteAnchors: [],
  target: null,
  paletteId: null,
};

const HARMONIES: readonly HarmonyType[] = [
  "similar",
  "complementary",
  "split-complementary",
  "analogous",
  "triadic",
  "tetradic",
  "monochromatic",
];

type ReadableParams = Pick<URLSearchParams, "get">;

/** `#RRGGBB` (upper case) from `RRGGBB` or `#RRGGBB`, else `null`. */
export function parseHexParam(value: string | null | undefined): string | null {
  if (!value) return null;
  const hex = value.startsWith("#") ? value : `#${value}`;
  return /^#[0-9A-Fa-f]{6}$/.test(hex) ? hex.toUpperCase() : null;
}

function oneOf<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function parseAnchors(value: string | null): string[] {
  if (!value) return [];
  const anchors: string[] = [];
  for (const raw of value.split(",")) {
    const hex = parseHexParam(raw.trim());
    if (hex && !anchors.includes(hex)) anchors.push(hex);
  }
  return anchors.slice(-MAX_PALETTE_ANCHORS);
}

export function parseColorSearchState(params: ReadableParams): ColorSearchUrlState {
  const harmony = params.get("harmony");
  return {
    color: parseHexParam(params.get("color")),
    harmony: harmony === "all" ? "all" : oneOf<ColorSearchHarmony>(harmony, HARMONIES, "all"),
    wheelMode: oneOf<ColorSearchWheelMode>(params.get("wheel"), ["free", "snap"], "free"),
    harmonyColorSet: oneOf<ColorSearchHarmonyColorSet>(params.get("set"), ["any", "all", "collection"], "any"),
    resultsScope: oneOf<ColorSearchResultsScope>(params.get("scope"), ["all", "collection"], "all"),
    toneFilter: oneOf<Undertone | "all">(params.get("tone"), ["warm", "cool", "neutral"], "all"),
    brandFilter: params.get("brand") || "all",
    finishFilter: params.get("finish") || "all",
    availabilityFilter: oneOf<ColorSearchAvailability>(params.get("avail"), ["owned", "wishlist"], "all"),
    paletteAnchors: parseAnchors(params.get("focus")),
    target: parseHexParam(params.get("target")),
    paletteId: params.get("palette") || null,
  };
}

/** Canonical query string (defaults omitted, hexes written without `#`). */
export function buildColorSearchQueryString(state: ColorSearchUrlState): string {
  const params = new URLSearchParams();
  const color = parseHexParam(state.color);
  if (color) params.set("color", color.slice(1));
  if (state.harmony !== "all") params.set("harmony", state.harmony);
  if (state.wheelMode !== "free") params.set("wheel", state.wheelMode);
  if (state.harmonyColorSet !== "any") params.set("set", state.harmonyColorSet);
  if (state.resultsScope !== "all") params.set("scope", state.resultsScope);
  if (state.toneFilter !== "all") params.set("tone", state.toneFilter);
  if (state.brandFilter !== "all") params.set("brand", state.brandFilter);
  if (state.finishFilter !== "all") params.set("finish", state.finishFilter);
  if (state.availabilityFilter !== "all") params.set("avail", state.availabilityFilter);
  const anchors = parseAnchors(state.paletteAnchors.join(","));
  if (anchors.length > 0) params.set("focus", anchors.map((hex) => hex.slice(1)).join(","));
  const target = parseHexParam(state.target);
  if (target) params.set("target", target.slice(1));
  if (state.paletteId) params.set("palette", state.paletteId);
  return params.toString();
}

export function colorSearchHref(state: ColorSearchUrlState): string {
  const query = buildColorSearchQueryString(state);
  return query ? `/polishes/search?${query}` : "/polishes/search";
}
