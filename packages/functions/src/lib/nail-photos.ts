import type { InvocationContext } from "@azure/functions";
import { query } from "./db";
import { deleteBlobFromStorageUrl, userMediaContainer } from "./blob-storage";
import { trackEvent, trackException } from "./telemetry";

/**
 * Storage helpers for private on-nail photos (#270) that other handlers need too
 * (`DELETE /api/polishes/{id}` removes the item's photo before the item itself).
 */

/**
 * Best-effort delete of nail-photo blobs after their rows are gone. Only blobs in the user-media
 * container can be targeted (anything else is refused by `deleteBlobFromStorageUrl`). Failures are
 * logged and reported but never thrown: the photo is already unreachable (no image_asset row, so
 * no v3 id can be minted for it), and the caller's request has succeeded.
 */
export async function deleteNailPhotoBlobs(
  storageUrls: readonly unknown[],
  context: InvocationContext
): Promise<void> {
  for (const storageUrl of storageUrls) {
    if (typeof storageUrl !== "string" || storageUrl.trim().length === 0) continue;
    try {
      await deleteBlobFromStorageUrl(storageUrl, { allowedContainers: [userMediaContainer()] });
    } catch (error) {
      context.warn(
        `[nail-photos] Failed to delete nail photo blob: ${error instanceof Error ? error.message : String(error)}`
      );
      trackEvent("nail_photo.blob_delete_failed");
      trackException(error, { area: "nail-photos", stage: "blob_delete" });
    }
  }
}

/**
 * Remove the caller's nail photo(s) for their inventory row of `shadeId`: deletes the image_asset
 * rows (the `inventory_nail_photo` link cascades) and returns their storage URLs so the caller can
 * delete the blobs once its own work succeeded. Scoped to `user_id = userId`; a no-op (one SELECT,
 * no DELETE) when there is no photo.
 */
export async function detachNailPhotosForShade(userId: number, shadeId: number): Promise<string[]> {
  const existing = await query<{ imageId: string }>(
    `SELECT p.image_id::text AS "imageId"
     FROM inventory_nail_photo p
     JOIN user_inventory_item ui ON ui.inventory_item_id = p.inventory_item_id
     WHERE ui.shade_id = $1
       AND ui.user_id = $2`,
    [shadeId, userId]
  );
  const imageIds = existing.rows
    .map((row) => Number(row.imageId))
    .filter((id) => Number.isSafeInteger(id) && id > 0);
  if (imageIds.length === 0) return [];

  const removed = await query<{ storageUrl: string }>(
    `DELETE FROM image_asset ia
     USING inventory_nail_photo p, user_inventory_item ui
     WHERE ia.image_id = p.image_id
       AND p.inventory_item_id = ui.inventory_item_id
       AND ia.image_id = ANY($1::bigint[])
       AND ia.owner_type = 'user'
       AND ui.shade_id = $2
       AND ui.user_id = $3
     RETURNING ia.storage_url AS "storageUrl"`,
    [imageIds, shadeId, userId]
  );
  return removed.rows.map((row) => row.storageUrl).filter((url) => typeof url === "string");
}
