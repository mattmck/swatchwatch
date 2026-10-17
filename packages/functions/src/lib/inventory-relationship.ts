import type { CaptureOwnership } from "swatchwatch-shared";
import { query } from "./db";

/**
 * One `user_inventory_item` row as far as ownership is concerned.
 *
 * TODO(#291): add `status` ("owned" | "wishlist" | "destash" | "archived") to this row and to
 * the SELECT in `loadInventoryOwnership` once the inventory status column lands.
 */
export interface InventoryOwnershipRow {
  shadeId: string | null;
  skuId: string | null;
  quantity: number | string | null;
}

/**
 * THE single place that decides whether inventory rows mean "owned", "wishlisted" or
 * "not owned". Everything that reports ownership for capture check goes through here.
 *
 * Current definition (no status column on `dev` yet), matching the polish list's
 * `availability` filter: a row with `quantity > 0` is owned, a row with `quantity <= 0` is
 * a wishlist entry, no row means not owned.
 *
 * TODO(#291): when `user_inventory_item.status` lands, switch to it here:
 * `status = 'owned'` → owned (sum its quantity), `status = 'wishlist'` → wishlisted, and
 * decide whether `destash` / `archived` read as owned or notOwned for the in-aisle answer.
 */
export function classifyInventoryOwnership(rows: readonly InventoryOwnershipRow[]): CaptureOwnership {
  if (rows.length === 0) {
    return { relationship: "notOwned" };
  }

  let ownedQuantity = 0;
  for (const row of rows) {
    const quantity = Number(row.quantity ?? 0);
    if (Number.isFinite(quantity) && quantity > 0) {
      ownedQuantity += quantity;
    }
  }

  if (ownedQuantity > 0) {
    return { relationship: "owned", quantity: ownedQuantity };
  }
  return { relationship: "wishlisted" };
}

/** A matched catalog entity to look up: its shade and, for a SKU match, the SKU. */
export interface OwnershipTarget {
  shadeId: string | null;
  skuId?: string | null;
}

/**
 * Read-only: the caller's inventory rows for the given shades/SKUs, classified per target.
 * A target matches rows on its shade (any SKU of it) or on its SKU. Scoped to `userId`;
 * issues exactly one SELECT (none when there is nothing to look up).
 */
export async function loadInventoryOwnership(
  userId: number,
  targets: readonly OwnershipTarget[]
): Promise<CaptureOwnership[]> {
  const shadeIds = [...new Set(targets.map((t) => t.shadeId).filter((id): id is string => Boolean(id)))];
  const skuIds = [...new Set(targets.map((t) => t.skuId).filter((id): id is string => Boolean(id)))];

  let rows: InventoryOwnershipRow[] = [];
  if (shadeIds.length > 0 || skuIds.length > 0) {
    const result = await query<InventoryOwnershipRow>(
      `SELECT
         shade_id::text AS "shadeId",
         sku_id::text   AS "skuId",
         quantity
       FROM user_inventory_item
       WHERE user_id = $1
         AND (shade_id = ANY($2::bigint[]) OR sku_id = ANY($3::bigint[]))`,
      [userId, shadeIds, skuIds]
    );
    rows = result.rows;
  }

  return targets.map((target) =>
    classifyInventoryOwnership(
      rows.filter(
        (row) =>
          (target.shadeId !== null && row.shadeId === target.shadeId)
          || (Boolean(target.skuId) && row.skuId === target.skuId)
      )
    )
  );
}
