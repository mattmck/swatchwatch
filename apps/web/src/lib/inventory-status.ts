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
 * - Decrementing an owned polish to zero bottles moves it to `wishlist` — the same outcome the
 *   old `quantity <= 0` encoding had, and what the migration backfilled such rows to.
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
  return quantity > 0 ? { quantity, status: "owned" } : { quantity: 0, status: "wishlist" };
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
