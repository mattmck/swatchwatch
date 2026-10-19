import type { MatchConfidence } from "swatchwatch-shared";

/**
 * OKLAB distance treated as "0% match" for the percentage readout. Same
 * normalization as the /polishes/search results list so the numbers agree.
 */
export const MATCH_PERCENT_MAX_DISTANCE = 0.5;

export const CONFIDENCE_META: Record<
  MatchConfidence,
  { label: string; badgeClassName: string; description: string }
> = {
  high: {
    label: "Close match",
    badgeClassName:
      "border border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200",
    description: "Reads as the same color",
  },
  medium: {
    label: "Similar",
    badgeClassName:
      "border border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-200",
    description: "Same family, different shade",
  },
  low: {
    label: "Loose",
    badgeClassName:
      "border border-neutral-300 bg-neutral-50 text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300",
    description: "Nearest you own, but noticeably different",
  },
};

/** 0–100 match score from an OKLAB distance (100 = identical). */
export function matchPercent(distance: number): number {
  const normalized = Math.min(Math.max(distance, 0) / MATCH_PERCENT_MAX_DISTANCE, 1);
  return Math.round((1 - normalized) * 100);
}

/** Format a 0–1 pixel share as a whole-number percent label (min "<1%"). */
export function formatFraction(fraction: number): string {
  const pct = Math.round(fraction * 100);
  return pct < 1 ? "<1%" : `${pct}%`;
}
