import type { Polish, PolishStatus } from "swatchwatch-shared";

/** Display labels for inventory statuses (issue #261). */
export const POLISH_STATUS_LABELS: Record<PolishStatus, string> = {
  owned: "Owned",
  wishlist: "Wishlist",
  destash: "Destash",
  archived: "Archived",
};

/** Statuses in display order (mirrors `POLISH_STATUSES` in swatchwatch-shared). */
export const POLISH_STATUS_OPTIONS: PolishStatus[] = ["owned", "wishlist", "destash", "archived"];

/** True when the polish is in the user's collection. Ownership comes from `status`, never `quantity`. */
export function isOwnedPolish(polish: Pick<Polish, "status">): boolean {
  return polish.status === "owned";
}

/**
 * The PUT body for a quantity-control click (`delta` = +1 / -1).
 *
 * - Adding a polish that is not owned (catalog row, wishlist, destash, archived) makes it
 *   `owned` with at least one bottle.
 * - Decrementing an owned polish to zero bottles moves it to `archived` ("no longer owned:
 *   used up, given away, sold"). Running out of a bottle is not the same as wanting it, so it
 *   no longer lands on the wishlist (#262 revisits #261's decision 4); re-wishlisting is one
 *   ♡ tap away when you do want it again.
 */
export function quantityChangeUpdate(
  polish: Pick<Polish, "status" | "quantity">,
  delta: number
): { quantity: number; status: PolishStatus } {
  const current = Math.max(0, polish.quantity ?? 0);
  if (!isOwnedPolish(polish)) {
    return delta > 0
      ? { quantity: Math.max(1, current), status: "owned" }
      : { quantity: current, status: polish.status ?? "wishlist" };
  }
  const quantity = Math.max(0, current + delta);
  return quantity > 0 ? { quantity, status: "owned" } : { quantity: 0, status: "archived" };
}

/** Format a purchase price for display, e.g. `$12.50` (null when no price is recorded). */
export function formatPurchasePrice(
  price: number | null | undefined,
  currency: string | null | undefined
): string | null {
  if (price === null || price === undefined || !Number.isFinite(price)) return null;
  if (currency && /^[A-Z]{3}$/.test(currency)) {
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(price);
    } catch {
      // Unknown ISO code: fall through to the plain format.
    }
  }
  return `${price.toFixed(2)}${currency ? ` ${currency}` : ""}`;
}

/** Dashboard collection summary (issue #262). */
export interface CollectionSummary {
  /** Owned polishes (`status === "owned"`). */
  owned: number;
  /** Owned polishes never tried (`isUntried`). */
  untried: number;
  /** Untried share of owned, 0–100 rounded to a whole percent; null when nothing is owned. */
  untriedPercent: number | null;
  /** Wishlist polishes (`status === "wishlist"`), from the API list `total`. */
  wishlist: number;
}

/**
 * Build the dashboard summary from the owned rows the dashboard already loads and the
 * wishlist `total` of a one-row `GET /api/polishes?status=wishlist&pageSize=1` request.
 * Rows that are not owned are ignored, so a stale or mixed list cannot skew the percentage.
 */
export function summarizeCollection(
  ownedRows: ReadonlyArray<Pick<Polish, "status" | "isUntried" | "triedAt">>,
  wishlistTotal: number
): CollectionSummary {
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
