import type { ColorFamily } from "../color/color-family";
import type { PaletteColorKind } from "../color/palette-quality";
import type { Polish } from "./polish";

/**
 * How closely a polish matches a color extracted from a photo, bucketed from
 * the OKLAB distance. Thresholds live in the Functions `color-match` lib
 * (`confidenceForDistance`).
 */
export type MatchConfidence = "high" | "medium" | "low";

/**
 * Which shades `POST /api/polishes/match-image` ranks (#105):
 * - `owned` (default): the caller's collection (`status = 'owned'`).
 * - `wishlist`: the caller's wishlist (`status = 'wishlist'`).
 * - `catalog`: every shade the caller can see (shared catalog plus their own private
 *   submissions), whatever their inventory status.
 */
export type MatchScope = "owned" | "wishlist" | "catalog";

export const MATCH_SCOPES: readonly MatchScope[] = ["owned", "wishlist", "catalog"];

export function isMatchScope(value: unknown): value is MatchScope {
  return typeof value === "string" && (MATCH_SCOPES as readonly string[]).includes(value);
}

/** A dominant color extracted from an uploaded image. */
export interface ExtractedColor {
  /** Uppercase `#RRGGBB`. */
  hex: string;
  /** Share (0–1) of sampled image pixels represented by this color. */
  fraction: number;
  /**
   * Palette quality (`classifyPaletteColor`): `light` / `dark` background, `skin`, or a real
   * `color`. Always set in API responses; clients typically hide the non-`color` kinds by default.
   */
  kind?: PaletteColorKind;
}

/**
 * Body for `POST /api/polishes/match-image`.
 *
 * The image is sent inline as a base64 data URL (the same convention as
 * capture frames). It is processed in memory only and never persisted.
 */
export interface PolishImageMatchRequest {
  /** `data:image/<type>;base64,<payload>` — JPEG/PNG/WebP/GIF, max 5 MB decoded. */
  image: string;
  /** Number of dominant colors to extract (1–10, default 6). */
  maxColors?: number;
  /** Max matches to return in `matches` (1–50, default 20). */
  limit?: number;
  /** Max matches per extracted color in `colorMatches` (1–20, default 5). */
  perColorLimit?: number;
  /** Shades to rank (default `owned`). */
  scope?: MatchScope;
  /** Only shades with at least one of these finishes (catalog names or aliases; max 20). */
  finishes?: string[];
  /** Only shades in one of these color families (`shade.color_family`; `gray` = `grey`). */
  families?: ColorFamily[];
  /** Drop `skin` palette colors before matching (default false). */
  excludeSkinTones?: boolean;
  /** Drop `light` / `dark` background palette colors before matching (default false). */
  excludeBackground?: boolean;
  /** Favor saturated colors over large grey/beige areas when choosing the palette (default false). */
  preferVibrant?: boolean;
}

/** One polish matched against the extracted palette. */
export interface PolishMatch {
  polish: Polish;
  /** The extracted color (uppercase hex) this polish is closest to. */
  matchedColor: string;
  /** OKLAB Euclidean distance to `matchedColor` (0 = identical; lower is closer). */
  distance: number;
  confidence: MatchConfidence;
}

/** The closest shades to one extracted color (`matchedColor` is always `hex`). */
export interface ColorMatchGroup {
  /** Uppercase `#RRGGBB`, one of `extractedColors`. */
  hex: string;
  /** Closest shades to `hex`, ascending distance. */
  matches: PolishMatch[];
}

export interface PolishImageMatchResponse {
  /** Dominant colors ordered most → least prominent. */
  extractedColors: ExtractedColor[];
  /** Closest shades to any extracted color, sorted by ascending distance. */
  matches: PolishMatch[];
  /**
   * Per-color top matches, one group per `extractedColors` entry in the same order. Because each
   * group holds a color's top `perColorLimit`, a client can re-rank any subset of the palette
   * locally (drop a chip) without uploading the image again.
   */
  colorMatches: ColorMatchGroup[];
  /** Shades with a usable hex that were considered (after scope and filters). */
  candidateCount: number;
  /** The scope that was ranked. */
  scope: MatchScope;
}
