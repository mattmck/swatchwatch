import type { ArchiveReason, Polish, PolishStatus, PolishUpdateRequest } from "swatchwatch-shared";

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
 * - Decrementing an owned polish to zero bottles archives it (decision D5c): running out is
 *   not wanting it again. The API records the reason (`used_up` unless the toast says
 *   otherwise); moving to the wishlist is a deliberate Rebuy, never automatic.
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

/** True when an update takes an owned polish to `archived` (show the archive toast). */
export function isArchivingChange(
  before: Pick<Polish, "status">,
  after: Pick<PolishUpdateRequest, "status">
): boolean {
  return isOwnedPolish(before) && after.status === "archived";
}

/**
 * Status the edit form saves: an owned polish saved with 0 bottles is archived (D5c), the same
 * as the − button. Any other combination keeps the chosen status.
 */
export function formStatusForSave(status: PolishStatus, quantity: number): PolishStatus {
  return status === "owned" && quantity <= 0 ? "archived" : status;
}

/** PUT body recording why an archived polish left the collection (the toast's reason buttons). */
export function archiveReasonUpdate(reason: ArchiveReason): PolishUpdateRequest {
  return { status: "archived", archiveReason: reason };
}

/** PUT body for the archive toast's Undo: back to owned with one bottle, reason removed. */
export function undoArchiveUpdate(): PolishUpdateRequest {
  return { status: "owned", quantity: 1, undoArchive: true };
}

/** True when the polish can be rebought (moved to the wishlist on purpose). */
export function canRebuy(polish: Pick<Polish, "status">): boolean {
  return polish.status === "archived";
}

/** PUT body for Rebuy on an archived polish: the only path from archived to the wishlist. */
export function rebuyUpdate(): PolishUpdateRequest {
  return { status: "wishlist" };
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
