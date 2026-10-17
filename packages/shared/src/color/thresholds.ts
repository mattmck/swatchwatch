import type { MatchConfidence } from "../types/color-match";

// ── Confidence thresholds ────────────────────────────────────────────────────
//
// Distances are plain Euclidean distance in OKLAB (`colorDistance` in
// ./oklab.ts, the same math the web app and the API use). On that scale
// black↔white is 1.0, and ~0.02 is roughly a just-noticeable difference.
//
// - HIGH (≤ 0.05): ~2–3 JNDs. Side by side you can tell them apart, but they
//   read as "the same color", which is about as tight as a phone photo (white
//   balance, lighting, compression) vs. a catalog hex can be expected to get.
// - MEDIUM (≤ 0.10): same hue family, visibly different shade. Brackets the
//   0.075 "you already have this" threshold used by /polishes/search.
// - LOW (> 0.10): nearest available, but a noticeably different color.
//
// Shared by photo → polish matching (`POST /api/polishes/match-image`) and by
// vendor ↔ detected hex reconciliation (`resolveDisplayHexDetailed`): a shade
// whose vendor and detected hexes are further apart than MEDIUM is flagged.
//
// Tune these here; nothing else hard-codes them.
export const HIGH_CONFIDENCE_MAX_DISTANCE = 0.05;
export const MEDIUM_CONFIDENCE_MAX_DISTANCE = 0.1;

/** Map an OKLAB distance to a confidence bucket. */
export function confidenceForDistance(distance: number): MatchConfidence {
  if (distance <= HIGH_CONFIDENCE_MAX_DISTANCE) return "high";
  if (distance <= MEDIUM_CONFIDENCE_MAX_DISTANCE) return "medium";
  return "low";
}
