import type { Polish, PolishStatus, PolishUpdateRequest } from "swatchwatch-shared";

/**
 * Row-level collection actions for the `/polishes` table (issue #262): status quick actions
 * (♡ wishlist, ✓ own, destash, archive) and "mark tried", plus the optimistic list reducers
 * the table uses to apply them before the API answers and roll them back on failure.
 *
 * Pure functions only (no React, no fetch) so they are unit-tested directly.
 */

export type CollectionAction =
  /** Move the row to a status (creates the inventory row for a catalog-only polish). */
  | { kind: "set-status"; status: PolishStatus }
  /** Take a wishlist polish off the wishlist: deletes the inventory row (back to catalog-only). */
  | { kind: "remove-from-wishlist" }
  /** Record the date the polish was first tried (`YYYY-MM-DD`), or `null` to mark it untried. */
  | { kind: "set-tried"; date: string | null };

/** How an action reaches the API: a `PUT /api/polishes/{id}` body, or a `DELETE`. */
export type CollectionActionRequest =
  | { method: "update"; body: PolishUpdateRequest }
  | { method: "delete" };

/** Fields an action can change on a row. */
export type InventoryPatch = Partial<Pick<Polish, "status" | "quantity" | "triedAt">>;

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Today's date in the viewer's time zone as `YYYY-MM-DD` (what a date input and the API use). */
export function localIsoDate(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** True for a real calendar date `YYYY-MM-DD` that is not after `today` (also `YYYY-MM-DD`). */
export function isValidTriedDate(value: string, today: string = localIsoDate()): boolean {
  if (!YMD_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return false;
  return value <= today;
}

/**
 * The fields a status change writes.
 *
 * - `owned` / `destash` (bottles you physically have) keep the bottle count, with at least one.
 * - `wishlist` / `archived` leave `quantity` alone: it is ignored while the polish is not owned,
 *   and "own it again" restores it (at least one).
 */
export function statusChangePatch(
  polish: Pick<Polish, "quantity">,
  status: PolishStatus
): { status: PolishStatus; quantity?: number } {
  if (status === "owned" || status === "destash") {
    return { status, quantity: Math.max(1, polish.quantity ?? 0) };
  }
  return { status };
}

/** The API request for an action, or null when the action does not apply to the row. */
export function collectionActionRequest(
  polish: Pick<Polish, "status" | "quantity" | "triedAt">,
  action: CollectionAction
): CollectionActionRequest | null {
  switch (action.kind) {
    case "set-status": {
      if (polish.status === action.status) return null;
      return { method: "update", body: statusChangePatch(polish, action.status) };
    }
    case "remove-from-wishlist":
      return polish.status === "wishlist" ? { method: "delete" } : null;
    case "set-tried": {
      if (!canMarkTried(polish)) return null;
      if (action.date !== null && !isValidTriedDate(action.date)) return null;
      return { method: "update", body: { triedAt: action.date } };
    }
  }
}

/** Mark-tried applies to bottles you have or had (owned, destash, archived), not to wishlist/catalog rows. */
export function canMarkTried(polish: Pick<Polish, "status">): boolean {
  return polish.status === "owned" || polish.status === "destash" || polish.status === "archived";
}

/** `YYYY-MM-DD` → the ISO timestamp the API stores (`T00:00:00.000Z`); other values pass through. */
function triedAtTimestamp(date: string | null): string | null {
  if (date === null) return null;
  return YMD_RE.test(date) ? `${date}T00:00:00.000Z` : date;
}

/** Apply a patch to a row, recomputing the derived `isUntried` (owned and never tried). */
export function applyInventoryPatch(polish: Polish, patch: InventoryPatch): Polish {
  const next: Polish = { ...polish, ...patch };
  next.isUntried = next.status === "owned" && !next.triedAt;
  return next;
}

/** The row as it should look right after the action, before the API answers. */
export function optimisticPolish(polish: Polish, action: CollectionAction): Polish {
  switch (action.kind) {
    case "set-status":
      return applyInventoryPatch(polish, statusChangePatch(polish, action.status));
    case "remove-from-wishlist":
      // Back to a catalog-only row: no inventory status, no bottles.
      return { ...polish, status: null, quantity: 0, triedAt: null, isUntried: false, inventoryItemId: undefined };
    case "set-tried":
      return applyInventoryPatch(polish, { triedAt: triedAtTimestamp(action.date) });
  }
}

/** Telemetry properties for a status change (`collection.status_changed`). */
export function statusChangeEvent(
  from: PolishStatus | null | undefined,
  to: PolishStatus | null,
  via: "quick-action" | "menu" | "stepper"
): { from: string; to: string; via: string } {
  return { from: from ?? "none", to: to ?? "none", via };
}

// ---------------------------------------------------------------------------
// Optimistic list reducers
//
// Each mutation replaces the row with an optimistic copy and remembers that object. When the
// request settles, the row is only touched if it is still that exact object: a later action
// on the same row (rapid stepper clicks, say) owns the row from then on, so an older success
// cannot overwrite it and an older failure cannot roll it back over newer state.
// ---------------------------------------------------------------------------

/** Replace the row with `optimistic` (no-op when the id is not in the list). */
export function applyOptimistic(list: Polish[], id: string, optimistic: Polish): Polish[] {
  let changed = false;
  const next = list.map((row) => {
    if (row.id !== id) return row;
    changed = true;
    return optimistic;
  });
  return changed ? next : list;
}

/** Swap the optimistic row for the server's row, unless a newer change already replaced it. */
export function commitOptimistic(
  list: Polish[],
  id: string,
  optimistic: Polish,
  server: Polish
): Polish[] {
  let changed = false;
  const next = list.map((row) => {
    if (row.id !== id || row !== optimistic) return row;
    changed = true;
    return server;
  });
  return changed ? next : list;
}

/** Put the original row back after a failed request, unless a newer change already replaced it. */
export function rollbackOptimistic(
  list: Polish[],
  id: string,
  optimistic: Polish,
  original: Polish
): Polish[] {
  return commitOptimistic(list, id, optimistic, original);
}
