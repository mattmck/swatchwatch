import type { Polish } from "swatchwatch-shared";

export interface CollectionSummary {
  owned: number;
  /** Owned and never tried. */
  untried: number;
  /** Untried share of owned, 0–100; null when nothing is owned. */
  untriedPercent: number | null;
  wishlist: number;
}

/**
 * Home counts (web: `summarizeCollection`): built from the owned rows already loaded for
 * "Pick for me" and the wishlist `total` of a one-row `status=wishlist` request. Rows that
 * are not owned are ignored.
 */
export function summarizeCollection(ownedRows: readonly Pick<Polish, "status" | "isUntried" | "triedAt">[], wishlistTotal: number): CollectionSummary {
  let owned = 0;
  let untried = 0;
  for (const row of ownedRows) {
    if (row.status !== "owned") continue;
    owned += 1;
    if (row.isUntried ?? !row.triedAt) untried += 1;
  }
  return {
    owned,
    untried,
    untriedPercent: owned > 0 ? Math.round((untried / owned) * 100) : null,
    wishlist: Math.max(0, Math.floor(Number.isFinite(wishlistTotal) ? wishlistTotal : 0)),
  };
}
