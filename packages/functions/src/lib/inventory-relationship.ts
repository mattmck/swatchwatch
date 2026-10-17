import type { CaptureOwnership } from "swatchwatch-shared";
import { query } from "./db";

/**
 * One `user_inventory_item` row as far as ownership is concerned.
 */
export interface InventoryOwnershipRow {
  shadeId: string | null;
  skuId: string | null;
  quantity: number | string | null;
  /** `user_inventory_item.status`: owned | wishlist | destash | archived (#291). */
  status: string | null;
}

/**
 * THE single place that decides whether inventory rows mean "owned", "wishlisted" or
 * "not owned". Everything that reports ownership for capture check goes through here.
 *
 * Uses the inventory status model (#291), where ownership is only `status = 'owned'` and
 * `quantity` never decides ownership (the same rule as the polish list's `status` /
 * `availability` filters):
 * - any `status = 'owned'` row → owned, `quantity` = the owned rows' quantities summed
 * - otherwise any `status = 'wishlist'` row → wishlisted
 * - otherwise (no row, or only `destash` / `archived` rows) → not owned
 */
export function classifyInventoryOwnership(rows: readonly InventoryOwnershipRow[]): CaptureOwnership {
  let hasOwned = false;
  let hasWishlist = false;
  let ownedQuantity = 0;
  for (const row of rows) {
    if (row.status === "owned") {
      hasOwned = true;
      const quantity = Number(row.quantity ?? 0);
      if (Number.isFinite(quantity) && quantity > 0) {
        ownedQuantity += quantity;
      }
    } else if (row.status === "wishlist") {
      hasWishlist = true;
    }
  }

  if (hasOwned) {
    return { relationship: "owned", quantity: ownedQuantity };
  }
  if (hasWishlist) {
    return { relationship: "wishlisted" };
  }
  return { relationship: "notOwned" };
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
         quantity,
         status
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
