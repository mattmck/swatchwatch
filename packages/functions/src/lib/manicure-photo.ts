import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { isUserMediaStorageUrl, storageUrlBlobName } from "./blob-storage";

/**
 * Storage rules for photos uploaded through `PUT /api/manicures/{id}/photo` (#327).
 *
 * Mani photos live in the private USER_MEDIA_CONTAINER under `{userId}/manicures/{manicureId}/`.
 * A manicure's `photo_image_id` may also point at any other `image_asset` the caller owns (e.g. a
 * nail photo), so cleanup only ever deletes an asset that this route created (recognized by that
 * blob path) and that nothing else references any more.
 */

const MANICURE_PHOTO_SEGMENT = "manicures";

/** Fresh, unguessable blob name for a mani photo upload: a replaced photo never reuses a URL. */
export function manicurePhotoBlobName(userId: number, manicureId: number): string {
  return `${userId}/${MANICURE_PHOTO_SEGMENT}/${manicureId}/${randomUUID()}.jpg`;
}

/** True when `storageUrl` is a mani photo blob of `userId` in the user-media container. */
export function isManicurePhotoStorageUrl(storageUrl: string, userId: number): boolean {
  if (!isUserMediaStorageUrl(storageUrl)) return false;
  const [owner, segment, manicureId, name] = storageUrlBlobName(storageUrl).split("/");
  return (
    owner === String(userId) &&
    segment === MANICURE_PHOTO_SEGMENT &&
    /^\d+$/.test(manicureId ?? "") &&
    typeof name === "string" &&
    name.length > 0
  );
}

/**
 * Delete the caller's former mani photo asset `imageId` once no manicure or nail photo references
 * it, returning its storage URL so the caller can delete the blob after its transaction commits.
 * Runs on the caller's transaction `client`, after the manicure row stopped pointing at it. Assets
 * not created by the mani photo route (other storage paths) are left alone. Scoped to
 * `owner_type = 'user' AND owner_id = userId`.
 */
export async function releaseManicurePhoto(
  client: Pick<PoolClient, "query">,
  userId: number,
  imageId: number | string | null | undefined
): Promise<string | null> {
  const id = Number(imageId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;

  const unreferenced = await client.query<{ storageUrl: string }>(
    `SELECT ia.storage_url AS "storageUrl"
     FROM image_asset ia
     WHERE ia.image_id = $1
       AND ia.owner_type = 'user'
       AND ia.owner_id = $2
       AND NOT EXISTS (SELECT 1 FROM manicure m WHERE m.photo_image_id = ia.image_id)
       AND NOT EXISTS (SELECT 1 FROM inventory_nail_photo p WHERE p.image_id = ia.image_id)`,
    [id, userId]
  );
  const storageUrl = unreferenced.rows[0]?.storageUrl;
  if (typeof storageUrl !== "string" || !isManicurePhotoStorageUrl(storageUrl, userId)) return null;

  const removed = await client.query<{ storageUrl: string }>(
    `DELETE FROM image_asset
     WHERE image_id = $1
       AND owner_type = 'user'
       AND owner_id = $2
     RETURNING storage_url AS "storageUrl"`,
    [id, userId]
  );
  return removed.rows[0]?.storageUrl ?? null;
}
