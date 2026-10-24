import { randomUUID } from "node:crypto";
import type { query as dbQuery } from "./db";
import {
  isUserMediaStorageUrl,
  storageUrlBlobName,
  uploadBytesToBlob,
  userMediaContainer,
} from "./blob-storage";

/**
 * Capture frame retention (Bottle Flow slice A).
 *
 * While `BOTTLE_CAPTURE_ENABLED` is on, the EXIF-stripped bytes of a Rapid Add frame are kept as a
 * private blob in USER_MEDIA_CONTAINER, named `{userId}/capture/{captureId}/{sha256}-{uploadId}.{ext}`
 * (a fresh id per upload, so a client retry with identical bytes never shares a blob with the
 * first attempt's row), so a session can be re-read until it is resolved. They are released (blob deleted, `image_asset` row
 * reset to the `inline://` placeholder) when the session reaches a terminal state, or by the
 * hourly sweep in `capture-frame-sweep.ts` once they are older than the retention window.
 *
 * Safety rules:
 * - Only blobs under the owner's `{ownerId}/capture/` prefix in the user-media container are ever
 *   deleted or reset. Nail photos, mani photos, bottle-eval frames and catalog blobs share that
 *   container (or a frame may reference a nail photo through `imageId`) and are skipped.
 * - Frames never get a `v3` proxy id and never appear in a response.
 * - Blob failures are best effort: warned, counted, never thrown.
 */

/** `image_asset.storage_url` for a frame whose bytes were not kept (and after release). */
export const CAPTURE_FRAME_INLINE_PREFIX = "inline://capture/";

export function inlineCaptureFrameUrl(captureId: string, checksum: string, extension: string): string {
  return `${CAPTURE_FRAME_INLINE_PREFIX}${captureId}/${checksum}.${extension}`;
}

/** `{userId}/capture/{captureId}/{checksum}-{uploadId}.{ext}`; `uploadId` is unique per upload. */
export function captureFrameBlobName(
  userId: number,
  captureId: string,
  checksum: string,
  extension: string,
  uploadId: string
): string {
  return `${userId}/capture/${captureId}/${checksum}-${uploadId}.${extension}`;
}

/** True for a blob in USER_MEDIA_CONTAINER under `{userId}/capture/`. */
export function isCaptureFrameStorageUrl(storageUrl: unknown, userId: number | string): boolean {
  if (typeof storageUrl !== "string" || storageUrl.trim().length === 0) return false;
  try {
    if (!isUserMediaStorageUrl(storageUrl)) return false;
    return storageUrlBlobName(storageUrl).startsWith(`${userId}/capture/`);
  } catch {
    return false;
  }
}

export interface StoreCaptureFrameInput {
  userId: number;
  captureId: string;
  bytes: Buffer;
  contentType: string;
  checksum: string;
  extension: string;
}

export interface StoreCaptureFrameDeps {
  upload?: typeof uploadBytesToBlob;
  /** Per-upload blob name suffix; defaults to a random UUID. */
  uploadId?: () => string;
  /** Defaults to AZURE_STORAGE_CONNECTION; an explicit empty/undefined value means "not configured". */
  connectionString?: string | undefined;
  warn?: (message: string, error?: unknown) => void;
}

/**
 * Keep a frame's bytes as a private blob. Returns the blob URL when stored; the inline placeholder
 * when storage is not configured or the upload fails (warned, never thrown).
 */
export async function storeCaptureFrameBytes(
  input: StoreCaptureFrameInput,
  deps: StoreCaptureFrameDeps = {}
): Promise<{ storageUrl: string; stored: boolean }> {
  const inline = { storageUrl: inlineCaptureFrameUrl(input.captureId, input.checksum, input.extension), stored: false };
  const connectionString = ("connectionString" in deps ? deps.connectionString : process.env.AZURE_STORAGE_CONNECTION)?.trim();
  if (!connectionString) return inline;
  try {
    const upload = deps.upload ?? uploadBytesToBlob;
    const storageUrl = await upload({
      connectionString,
      containerName: userMediaContainer(),
      blobName: captureFrameBlobName(
        input.userId,
        input.captureId,
        input.checksum,
        input.extension,
        (deps.uploadId ?? randomUUID)()
      ),
      bytes: input.bytes,
      contentType: input.contentType,
    });
    return { storageUrl, stored: true };
  } catch (error) {
    deps.warn?.("[capture-frame-store] Frame blob upload failed; keeping the inline placeholder", error);
    return inline;
  }
}

/**
 * An `image_asset` a capture frame shares with something else: a mani photo, a nail photo, or
 * another `capture_frame` row (a frame of one session attached to another by `imageId`). Such an
 * asset is never released, by the session or by the sweep; `cf` is the frame being released.
 */
export const FRAME_ASSET_SHARED_ELSEWHERE_SQL = `(
    EXISTS (SELECT 1 FROM manicure m WHERE m.photo_image_id = ia.image_id)
    OR EXISTS (SELECT 1 FROM inventory_nail_photo p WHERE p.image_id = ia.image_id)
    OR EXISTS (
      SELECT 1 FROM capture_frame other
      WHERE other.image_id = ia.image_id AND other.capture_frame_id <> cf.capture_frame_id
    )
  )`;

/**
 * $1 capture_session_id, $2 user_id → frames whose image_asset is the caller's, not inline, and
 * not shared with a photo or another frame.
 */
export const SELECT_SESSION_FRAME_BLOBS_SQL = `SELECT ia.image_id::text AS "imageId",
       ia.storage_url AS "storageUrl",
       ia.checksum_sha256 AS "checksum",
       cs.capture_uuid::text AS "captureId"
FROM capture_frame cf
JOIN capture_session cs ON cs.capture_session_id = cf.capture_session_id
JOIN image_asset ia ON ia.image_id = cf.image_id
WHERE cf.capture_session_id = $1
  AND cs.user_id = $2
  AND ia.owner_type = 'user'
  AND ia.owner_id = $2
  AND ia.storage_url NOT LIKE 'inline://%'
  AND NOT ${FRAME_ASSET_SHARED_ELSEWHERE_SQL}
ORDER BY ia.image_id`;

/** $1 image_id, $2 placeholder URL, $3 owner id. Touches only the storage URL. */
export const RESET_FRAME_STORAGE_URL_SQL = `UPDATE image_asset
SET storage_url = $2
WHERE image_id = $1
  AND owner_type = 'user'
  AND owner_id = $3`;

export interface FrameBlobRow {
  imageId: string;
  storageUrl: string;
  checksum: string | null;
  captureId: string;
}

export interface ReleaseDeps {
  query: typeof dbQuery;
  /** Deletes a user-media blob: true when deleted, false when it did not exist (404). */
  deleteBlob: (storageUrl: string) => Promise<boolean>;
  warn?: (message: string, error?: unknown) => void;
}

export type FrameReleaseOutcome = "released" | "blobMissing" | "failed" | "skipped";

/** `…/{captureId}/{checksum}-{uploadId}.{ext}` → the file name's extension, or `jpg` when it has none. */
function frameExtension(storageUrl: string): string {
  const name = storageUrlBlobName(storageUrl).split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1) : "jpg";
}

/** The row's checksum, else the blob name's `{checksum}` (before `-{uploadId}` and the extension). */
function frameChecksum(row: FrameBlobRow): string {
  if (row.checksum) return row.checksum;
  const name = storageUrlBlobName(row.storageUrl).split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const dash = stem.indexOf("-");
  return dash > 0 ? stem.slice(0, dash) : stem;
}

/**
 * Release one frame: delete its blob, then reset the row to the inline placeholder. The blob goes
 * first so a failed reset is retried by the sweep (the blob is then a 404, counted as missing).
 * A row that is not the owner's capture frame is left untouched.
 */
export async function releaseCaptureFrame(
  ownerId: number | string,
  row: FrameBlobRow,
  fallbackCaptureId: string,
  deps: ReleaseDeps
): Promise<FrameReleaseOutcome> {
  if (!isCaptureFrameStorageUrl(row.storageUrl, ownerId)) return "skipped";
  let missing: boolean;
  try {
    missing = !(await deps.deleteBlob(row.storageUrl));
  } catch (error) {
    deps.warn?.(`[capture-frame-store] Frame blob delete failed for image ${row.imageId}`, error);
    return "failed";
  }
  try {
    await deps.query(RESET_FRAME_STORAGE_URL_SQL, [
      row.imageId,
      inlineCaptureFrameUrl(row.captureId || fallbackCaptureId, frameChecksum(row), frameExtension(row.storageUrl)),
      ownerId,
    ]);
  } catch (error) {
    deps.warn?.(`[capture-frame-store] Frame row reset failed for image ${row.imageId} (retried by the sweep)`, error);
    return "failed";
  }
  return missing ? "blobMissing" : "released";
}

/**
 * After a terminal commit: delete each of the session's frame blobs and reset its row to the
 * inline placeholder. Best effort; returns counts only (`released` includes `blobMissing`).
 */
export async function releaseCaptureFrames(
  input: { sessionId: number; userId: number; captureId: string },
  deps: ReleaseDeps
): Promise<{ released: number; blobMissing: number; failed: number }> {
  const result = { released: 0, blobMissing: 0, failed: 0 };
  let rows: FrameBlobRow[];
  try {
    rows = (await deps.query<FrameBlobRow>(SELECT_SESSION_FRAME_BLOBS_SQL, [input.sessionId, input.userId])).rows;
  } catch (error) {
    deps.warn?.(`[capture-frame-store] Frame lookup failed for session ${input.sessionId}`, error);
    return result;
  }
  for (const row of rows) {
    const outcome = await releaseCaptureFrame(input.userId, row, input.captureId, deps);
    if (outcome === "released") result.released += 1;
    else if (outcome === "blobMissing") {
      result.released += 1;
      result.blobMissing += 1;
    } else if (outcome === "failed") result.failed += 1;
  }
  return result;
}
