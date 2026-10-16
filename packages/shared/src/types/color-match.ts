import type { Polish } from "./polish";

/**
 * How closely a polish matches a color extracted from a photo, bucketed from
 * the OKLAB distance. Thresholds live in the Functions `color-match` lib
 * (`confidenceForDistance`).
 */
export type MatchConfidence = "high" | "medium" | "low";

/** A dominant color extracted from an uploaded image. */
export interface ExtractedColor {
  /** Uppercase `#RRGGBB`. */
  hex: string;
  /** Share (0–1) of sampled image pixels represented by this color. */
  fraction: number;
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
  /** Max matches to return (1–50, default 20). */
  limit?: number;
}

/** One polish from the caller's collection matched against the extracted palette. */
export interface PolishMatch {
  polish: Polish;
  /** The extracted color (uppercase hex) this polish is closest to. */
  matchedColor: string;
  /** OKLAB Euclidean distance to `matchedColor` (0 = identical; lower is closer). */
  distance: number;
  confidence: MatchConfidence;
}

export interface PolishImageMatchResponse {
  /** Dominant colors ordered most → least prominent. */
  extractedColors: ExtractedColor[];
  /** Closest owned polishes, sorted by ascending distance. */
  matches: PolishMatch[];
  /** Owned polishes with a usable hex that were considered. */
  candidateCount: number;
}
