/**
 * Mani log photo upload (#327):
 *
 *   PUT    /api/manicures/{id}/photo  → upload or replace; { manicureId, photoImageId, photoUrl }
 *   DELETE /api/manicures/{id}/photo  → 204 (idempotent)
 *
 * The manicure must belong to the caller; anyone else gets 404 before any body parsing, image work
 * or storage access. Uploads go through the same pipeline as nail photos (#270): decoded and
 * re-encoded server-side (EXIF/GPS and all other metadata removed, orientation applied, longest
 * edge capped, see lib/nail-photo-image), stored in the private USER_MEDIA_CONTAINER and linked
 * through an `image_asset` row (owner_type 'user') that becomes `manicure.photo_image_id`.
 * Responses only carry owner-scoped `v3` image proxy URLs (#227) and are `Cache-Control: private,
 * no-store`. A replaced or removed photo is deleted when this route created it and nothing else
 * references it (see lib/manicure-photo).
 */
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { ManicurePhotoResponse } from "swatchwatch-shared";
import { query, transaction } from "../lib/db";
import { withAuth } from "../lib/auth";
import { withCors } from "../lib/http";
import { internalServerError } from "../lib/errors";
import { uploadBytesToBlob, userMediaContainer } from "../lib/blob-storage";
import { toImageProxyUrl } from "../lib/image-proxy";
import { ManicureRequestError, parsePositiveId } from "../lib/manicure";
import { manicurePhotoBlobName, releaseManicurePhoto } from "../lib/manicure-photo";
import { NailPhotoInputError, normalizeNailPhoto, parseNailPhotoDataUrl } from "../lib/nail-photo-image";
import { readPhotoUploadBody } from "../lib/nail-photo-upload";
import { deleteNailPhotoBlobs } from "../lib/nail-photos";
import { trackEvent } from "../lib/telemetry";

interface OwnedManicureRow {
  id: string;
  photoImageId: string | null;
}

const SELECT_OWN_MANICURE = `
  SELECT manicure_id::text AS id,
         photo_image_id::text AS "photoImageId"
  FROM manicure
  WHERE manicure_id = $1
    AND user_id = $2`;

const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" };

function notFound(): HttpResponseInit {
  return { status: 404, jsonBody: { error: "Manicure not found" } };
}

function parseManicureId(request: HttpRequest): number {
  return parsePositiveId(request.params.id, "Manicure id");
}

function photoUrlFor(storageUrl: string, requestUrl: string, userId: number, context: InvocationContext): string | null {
  try {
    return toImageProxyUrl(requestUrl, storageUrl, { ownerUserId: userId });
  } catch (error) {
    context.error(
      `[manicure-photos] Omitting photo URL: failed to build signed image proxy URL (${
        error instanceof Error ? error.message : String(error)
      })`
    );
    return null;
  }
}

async function putManicurePhoto(
  request: HttpRequest,
  context: InvocationContext,
  userId: number
): Promise<HttpResponseInit> {
  let uploadedStorageUrl: string | null = null;
  try {
    const manicureId = parseManicureId(request);
    // Ownership first: nobody else's request reaches body parsing, image decoding or storage.
    const owned = await query<OwnedManicureRow>(SELECT_OWN_MANICURE, [manicureId, userId]);
    if (owned.rows.length === 0) return notFound();

    const body = await readPhotoUploadBody(request);
    const { bytes } = parseNailPhotoDataUrl(body.image);
    const photo = await normalizeNailPhoto(bytes);

    const connectionString = process.env.AZURE_STORAGE_CONNECTION?.trim();
    if (!connectionString) {
      context.error("[manicure-photos] AZURE_STORAGE_CONNECTION is not configured; cannot store mani photos");
      return { status: 503, jsonBody: { error: "Photo storage is not configured" } };
    }

    uploadedStorageUrl = await uploadBytesToBlob({
      connectionString,
      containerName: userMediaContainer(),
      blobName: manicurePhotoBlobName(userId, manicureId),
      bytes: photo.bytes,
      contentType: photo.contentType,
    });
    const storageUrl = uploadedStorageUrl;

    const { imageId, hadPhoto, previousStorageUrl } = await transaction(async (client) => {
      // Lock the caller's manicure so concurrent uploads replace each other cleanly.
      const locked = await client.query<OwnedManicureRow>(`${SELECT_OWN_MANICURE}\n  FOR UPDATE`, [
        manicureId,
        userId,
      ]);
      const current = locked.rows[0];
      if (!current) throw new ManicureRequestError(404, "Manicure not found");

      const asset = await client.query<{ imageId: string }>(
        `INSERT INTO image_asset (owner_type, owner_id, storage_url, checksum_sha256, copyright_status, captured_at)
         VALUES ('user', $1, $2, $3, 'user_uploaded', now())
         RETURNING image_id::text AS "imageId"`,
        [userId, storageUrl, photo.checksumSha256]
      );
      const newImageId = asset.rows[0].imageId;

      await client.query(
        `UPDATE manicure
         SET photo_image_id = $3::bigint,
             updated_at = now()
         WHERE manicure_id = $1
           AND user_id = $2`,
        [manicureId, userId, newImageId]
      );
      const previous = await releaseManicurePhoto(client, userId, current.photoImageId);
      return { imageId: newImageId, hadPhoto: Boolean(current.photoImageId), previousStorageUrl: previous };
    });
    uploadedStorageUrl = null; // committed: the blob is now referenced

    if (previousStorageUrl) {
      await deleteNailPhotoBlobs([previousStorageUrl], context);
    }
    trackEvent("manicure_photo.uploaded", {
      replaced: hadPhoto,
      sizeBytes: photo.bytes.length,
      width: photo.width,
      height: photo.height,
    });

    const responseBody: ManicurePhotoResponse = {
      manicureId: String(manicureId),
      photoImageId: imageId,
      photoUrl: photoUrlFor(storageUrl, request.url, userId, context),
    };
    return { status: hadPhoto ? 200 : 201, headers: NO_STORE_HEADERS, jsonBody: responseBody };
  } catch (error) {
    if (uploadedStorageUrl) {
      // Not linked to anything: remove it so a failed upload leaves no private media behind.
      await deleteNailPhotoBlobs([uploadedStorageUrl], context);
    }
    if (error instanceof ManicureRequestError) {
      return { status: error.status, jsonBody: { error: error.message } };
    }
    if (error instanceof NailPhotoInputError) {
      trackEvent("manicure_photo.rejected", { status: error.status });
      return { status: error.status, jsonBody: { error: error.message } };
    }
    return internalServerError(context, error, "Failed to save mani photo", "manicure-photos.put");
  }
}

async function deleteManicurePhoto(
  request: HttpRequest,
  context: InvocationContext,
  userId: number
): Promise<HttpResponseInit> {
  try {
    const manicureId = parseManicureId(request);
    const removedStorageUrl = await transaction(async (client) => {
      const locked = await client.query<OwnedManicureRow>(`${SELECT_OWN_MANICURE}\n  FOR UPDATE`, [
        manicureId,
        userId,
      ]);
      const current = locked.rows[0];
      if (!current) throw new ManicureRequestError(404, "Manicure not found");
      if (!current.photoImageId) return null;

      await client.query(
        `UPDATE manicure
         SET photo_image_id = NULL,
             updated_at = now()
         WHERE manicure_id = $1
           AND user_id = $2`,
        [manicureId, userId]
      );
      return releaseManicurePhoto(client, userId, current.photoImageId);
    });

    if (removedStorageUrl) {
      await deleteNailPhotoBlobs([removedStorageUrl], context);
    }
    trackEvent("manicure_photo.deleted", { blobDeleted: Boolean(removedStorageUrl) });
    return { status: 204, headers: NO_STORE_HEADERS };
  } catch (error) {
    if (error instanceof ManicureRequestError) {
      return { status: error.status, jsonBody: { error: error.message } };
    }
    return internalServerError(context, error, "Failed to delete mani photo", "manicure-photos.delete");
  }
}

app.http("manicure-photo", {
  methods: ["PUT", "DELETE", "OPTIONS"],
  authLevel: "anonymous",
  route: "manicures/{id}/photo",
  handler: withCors(
    withAuth(async (request, context, userId) => {
      switch (request.method?.toUpperCase()) {
        case "PUT":
          return putManicurePhoto(request, context, userId);
        case "DELETE":
          return deleteManicurePhoto(request, context, userId);
        default:
          return { status: 405, jsonBody: { error: "Method not allowed" } };
      }
    })
  ),
});
