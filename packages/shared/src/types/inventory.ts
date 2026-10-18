/**
 * Inventory status model (issue #261).
 *
 * Each `user_inventory_item` row carries one status. "Untried" is not a status: it is derived
 * as `status === "owned"` with no `triedAt` (see `isUntriedInventory`), and the API returns it
 * as `Polish.isUntried`.
 */
export const POLISH_STATUSES = ["owned", "wishlist", "destash", "archived"] as const;

/**
 * - `owned`    — in the collection (the only status counted as "owned" by filters, the
 *               dashboard, gap analysis and photo matching)
 * - `wishlist` — wanted, not owned
 * - `destash`  — still owned but up for sale/swap
 * - `archived` — no longer owned (used up, given away, sold)
 */
export type PolishStatus = (typeof POLISH_STATUSES)[number];

/** True when `value` is one of `POLISH_STATUSES` (exact, case-sensitive). */
export function isPolishStatus(value: unknown): value is PolishStatus {
  return typeof value === "string" && (POLISH_STATUSES as readonly string[]).includes(value);
}

/** True when the item is in the user's collection (`status === "owned"`). */
export function isOwnedStatus(status: PolishStatus | null | undefined): boolean {
  return status === "owned";
}

/** Derived "untried": owned and never tried. Mirrors the SQL behind `Polish.isUntried`. */
export function isUntriedInventory(item: {
  status?: PolishStatus | null;
  triedAt?: string | null;
}): boolean {
  return item.status === "owned" && !item.triedAt;
}

/**
 * Why an owned polish left the collection (decision D5c). Sent as `archiveReason` with
 * `status: "archived"` and stored as the `inventory_event.event_type`, distinct from the mani
 * log's `used` events.
 * - `used_up`     — the bottle ran out (the default when − takes the last bottle to 0)
 * - `decluttered` — given away, sold or swapped
 */
export const ARCHIVE_REASONS = ["used_up", "decluttered"] as const;
export type ArchiveReason = (typeof ARCHIVE_REASONS)[number];

/** Display labels for `ArchiveReason`. */
export const ARCHIVE_REASON_LABELS: Readonly<Record<ArchiveReason, string>> = Object.freeze({
  used_up: "Used up",
  decluttered: "Gave away",
});

/** True when `value` is one of `ARCHIVE_REASONS` (exact, case-sensitive). */
export function isArchiveReason(value: unknown): value is ArchiveReason {
  return typeof value === "string" && (ARCHIVE_REASONS as readonly string[]).includes(value);
}
