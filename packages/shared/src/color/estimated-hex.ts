import type { MatchConfidence } from "../types/color-match";
import type { Polish } from "../types/polish";
import { confidenceForDistance } from "./thresholds";

/**
 * Estimated display colors.
 *
 * A shade's display hex is vendor > detected > name (`resolveDisplayHex`). When neither a
 * vendor hex nor a detected hex is stored, the display hex is only `name_hex`, a guess from
 * the shade's color name: "Mirage", "Illusion" and "Supernova" all came out as the same
 * slate blue. Color search therefore ranks estimated shades after every shade with a measured
 * hex and never grades them above low. `GET /api/polishes?nearHex=` applies the same rule in
 * SQL (`NEAR_HEX_TIER_SQL` in packages/functions/src/lib/near-hex.ts).
 */

/** True when the display hex is only a guess from the color name (no vendor or detected hex). */
export function isEstimatedDisplayHex(polish: Pick<Polish, "vendorHex" | "detectedHex" | "nameHex">): boolean {
  return !polish.vendorHex && !polish.detectedHex && !!polish.nameHex;
}

/** Match grade for a color-search row: `confidenceForDistance`, capped at low for an estimated hex. */
export function colorSearchConfidence(distance: number, estimated: boolean): MatchConfidence {
  return estimated ? "low" : confidenceForDistance(distance);
}

/**
 * Comparator for color-search rows: measured hexes before estimated ones, then nearest first.
 * Callers add their own tiebreak.
 */
export function compareColorSearchRank(
  a: { distance: number; estimated: boolean },
  b: { distance: number; estimated: boolean },
): number {
  return Number(a.estimated) - Number(b.estimated) || a.distance - b.distance;
}
