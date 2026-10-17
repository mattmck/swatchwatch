import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { randomUUID } from "node:crypto";
import {
  NAIL_PHOTO_MAX_UPLOAD_BYTES,
  type NailPhoto,
  type NailPhotoResponse,
  type NailPhotoUploadRequest,
} from "swatchwatch-shared";
import { query, transaction } from "../lib/db";
import { withAuth } from "../lib/auth";
import { withCors } from "../lib/http";
import { internalServerError } from "../lib/errors";
import { isUserMediaStorageUrl, uploadBytesToBlob, userMediaContainer } from "../lib/blob-storage";
import { toImageProxyUrl } from "../lib/image-proxy";
import { NailPhotoInputError, normalizeNailPhoto, parseNailPhotoDataUrl } from "../lib/nail-photo-image";
import { deleteNailPhotoBlobs } from "../lib/nail-photos";
import { trackEvent } from "../lib/telemetry";

/**
 * Private on-nail photo per inventory item (#270).
 *
 *   GET    /api/inventory/{inventoryItemId}/nail-photo  → { photo: NailPhoto | null }
 *   PUT    /api/inventory/{inventoryItemId}/nail-photo  → upload or replace; { photo }
 *   DELETE /api/inventory/{inventoryItemId}/nail-photo  → 204 (idempotent)
 *
 * The inventory item must belong to the caller; anyone else gets 404 before any body parsing,
 * image work or storage access. Uploads are decoded and re-encoded server-side (EXIF/GPS and all
 * other metadata removed, orientation applied, longest edge capped, see lib/nail-photo-image),
 * stored in the private USER_MEDIA_CONTAINER and linked through an `image_asset` row
 * (owner_type 'user'). Responses only ever carry owner-scoped `v3` image proxy URLs (#227), never
 * raw blob URLs or public `v2` ids, and are `Cache-Control: private, no-store`.
 */

/** Ownership + current photo for one inventory item, scoped to the caller. */
interface NailPhotoRow {
  inventoryItemId: string;
  shadeId: string | null;
  imageId: string | null;
  storageUrl: string | null;
  contentType: string | null;
  width: number | null;
  height: number | null;
  sizeBytes: number | null;
  createdAt: string | Date | null;
  updatedAt: string | Date | null;
}

const SELECT_ITEM_WITH_PHOTO = `
  SELECT ui.inventory_item_id::text AS "inventoryItemId",
         ui.shade_id::text AS "shadeId",
         p.image_id::text AS "imageId",
         ia.storage_url AS "storageUrl",
         p.content_type AS "contentType",
         p.width,
         p.height,
         p.size_bytes AS "sizeBytes",
         p.created_at AS "createdAt",
         p.updated_at AS "updatedAt"
  FROM user_inventory_item ui
  LEFT JOIN inventory_nail_photo p ON p.inventory_item_id = ui.inventory_item_id
  LEFT JOIN image_asset ia ON ia.image_id = p.image_id AND ia.owner_type = 'user'
  WHERE ui.inventory_item_id = $1
    AND ui.user_id = $2`;

/** Generous allowance for JSON framing around the base64 payload. */
const MAX_REQUEST_BODY_BYTES = Math.ceil(NAIL_PHOTO_MAX_UPLOAD_BYTES / 3) * 4 + 64 * 1024;

const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" };

class InventoryItemNotFoundError extends Error {
  constructor() {
    super("Inventory item not found");
    this.name = "InventoryItemNotFoundError";
  }
}

function notFound(): HttpResponseInit {
  return { status: 404, jsonBody: { error: "Inventory item not found" } };
}

/** Strict positive-integer id from the route, or null. */
function parseInventoryItemId(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function toIso(value: string | Date | null | undefined): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.length > 0) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
  }
  return new Date().toISOString();
}

function toNullableInt(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/**
 * Owner-scoped `v3` proxy URL for a photo the caller owns, or null. Only blobs in the user-media
 * container qualify; anything else (or a signing failure) is omitted rather than exposed.
 */
function toOwnerImageUrl(
  storageUrl: string | null,
  requestUrl: string,
  userId: number,
  context: InvocationContext
): string | null {
  if (!storageUrl) return null;
  try {
    if (!isUserMediaStorageUrl(storageUrl)) {
      context.warn("[nail-photos] Stored nail photo is outside the user-media container; omitting it");
      return null;
    }
    return toImageProxyUrl(requestUrl, storageUrl, { ownerUserId: userId });
  } catch (error) {
    context.error(
      `[nail-photos] Omitting nail photo URL: failed to build signed image proxy URL (${
        error instanceof Error ? error.message : String(error)
      })`
    );
    return null;
  }
}

function toNailPhoto(
  row: NailPhotoRow,
  requestUrl: string,
  userId: number,
  context: InvocationContext
): NailPhoto | null {
  if (!row.imageId || !row.storageUrl) return null;
  return {
    inventoryItemId: row.inventoryItemId,
    shadeId: row.shadeId ?? null,
    imageUrl: toOwnerImageUrl(row.storageUrl, requestUrl, userId, context),
    contentType: row.contentType || "image/jpeg",
    width: toNullableInt(row.width),
    height: toNullableInt(row.height),
    sizeBytes: toNullableInt(row.sizeBytes),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

function photoResponse(status: number, photo: NailPhoto | null): HttpResponseInit {
  const body: NailPhotoResponse = { photo };
  return { status, headers: NO_STORE_HEADERS, jsonBody: body };
}

async function findOwnedItem(inventoryItemId: number, userId: number): Promise<NailPhotoRow | null> {
  const result = await query<NailPhotoRow>(SELECT_ITEM_WITH_PHOTO, [inventoryItemId, userId]);
  return result.rows[0] ?? null;
}

async function getNailPhoto(
  request: HttpRequest,
  context: InvocationContext,
  userId: number
): Promise<HttpResponseInit> {
  const inventoryItemId = parseInventoryItemId(request.params.inventoryItemId);
  if (inventoryItemId === null) {
    return { status: 400, jsonBody: { error: "Invalid inventory item id" } };
  }
  try {
    const row = await findOwnedItem(inventoryItemId, userId);
    if (!row) return notFound();
    return photoResponse(200, toNailPhoto(row, request.url, userId, context));
  } catch (error) {
    return internalServerError(context, error, "Failed to load nail photo", "nail-photos.get");
  }
}

async function readUploadBody(request: HttpRequest): Promise<NailPhotoUploadRequest> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BODY_BYTES) {
    throw new NailPhotoInputError(
      `Image too large: the limit is ${(NAIL_PHOTO_MAX_UPLOAD_BYTES / (1024 * 1024)).toFixed(0)} MB`,
      413
    );
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new NailPhotoInputError("Request body must be JSON: { \"image\": \"data:image/jpeg;base64,...\" }");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new NailPhotoInputError("Request body must be JSON: { \"image\": \"data:image/jpeg;base64,...\" }");
  }
  return body as NailPhotoUploadRequest;
}

async function putNailPhoto(
  request: HttpRequest,
  context: InvocationContext,
  userId: number
): Promise<HttpResponseInit> {
  const inventoryItemId = parseInventoryItemId(request.params.inventoryItemId);
  if (inventoryItemId === null) {
    return { status: 400, jsonBody: { error: "Invalid inventory item id" } };
  }

  let uploadedStorageUrl: string | null = null;
  try {
    // Ownership first: nobody else's request reaches body parsing, image decoding or storage.
    const owned = await findOwnedItem(inventoryItemId, userId);
    if (!owned) return notFound();

    const body = await readUploadBody(request);
    const { bytes } = parseNailPhotoDataUrl(body.image);
    const photo = await normalizeNailPhoto(bytes);

    const connectionString = process.env.AZURE_STORAGE_CONNECTION?.trim();
    if (!connectionString) {
      context.error("[nail-photos] AZURE_STORAGE_CONNECTION is not configured; cannot store nail photos");
      return { status: 503, jsonBody: { error: "Photo storage is not configured" } };
    }

    // Random, unguessable name per upload: a replaced photo never reuses a URL.
    uploadedStorageUrl = await uploadBytesToBlob({
      connectionString,
      containerName: userMediaContainer(),
      blobName: `${userId}/${inventoryItemId}/${randomUUID()}.jpg`,
      bytes: photo.bytes,
      contentType: photo.contentType,
    });
    const storageUrl = uploadedStorageUrl;

    const { saved, previousStorageUrl } = await transaction(async (client) => {
      // Lock the caller's item so concurrent uploads replace each other cleanly.
      const locked = await client.query<NailPhotoRow>(`${SELECT_ITEM_WITH_PHOTO}\n  FOR UPDATE OF ui`, [
        inventoryItemId,
        userId,
      ]);
      const current = locked.rows[0];
      if (!current) throw new InventoryItemNotFoundError();

      const asset = await client.query<{ imageId: string }>(
        `INSERT INTO image_asset (owner_type, owner_id, storage_url, checksum_sha256, copyright_status, captured_at)
         VALUES ('user', $1, $2, $3, 'user_uploaded', now())
         RETURNING image_id::text AS "imageId"`,
        [userId, storageUrl, photo.checksumSha256]
      );
      const imageId = asset.rows[0].imageId;

      const link = await client.query<{ createdAt: string | Date; updatedAt: string | Date }>(
        `INSERT INTO inventory_nail_photo (inventory_item_id, image_id, content_type, width, height, size_bytes)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (inventory_item_id) DO UPDATE
         SET image_id = EXCLUDED.image_id,
             content_type = EXCLUDED.content_type,
             width = EXCLUDED.width,
             height = EXCLUDED.height,
             size_bytes = EXCLUDED.size_bytes,
             updated_at = now()
         RETURNING created_at AS "createdAt", updated_at AS "updatedAt"`,
        [inventoryItemId, imageId, photo.contentType, photo.width, photo.height, photo.bytes.length]
      );

      let previous: string | null = null;
      if (current.imageId && current.imageId !== imageId) {
        // The id came from the caller-scoped, locked lookup above.
        const removed = await client.query<{ storageUrl: string }>(
          `DELETE FROM image_asset
           WHERE image_id = $1
             AND owner_type = 'user'
           RETURNING storage_url AS "storageUrl"`,
          [current.imageId]
        );
        previous = removed.rows[0]?.storageUrl ?? null;
      }

      const row: NailPhotoRow = {
        inventoryItemId: current.inventoryItemId,
        shadeId: current.shadeId,
        imageId,
        storageUrl,
        contentType: photo.contentType,
        width: photo.width,
        height: photo.height,
        sizeBytes: photo.bytes.length,
        createdAt: link.rows[0]?.createdAt ?? null,
        updatedAt: link.rows[0]?.updatedAt ?? null,
      };
      return { saved: row, previousStorageUrl: previous };
    });
    uploadedStorageUrl = null; // committed: the blob is now referenced

    if (previousStorageUrl) {
      await deleteNailPhotoBlobs([previousStorageUrl], context);
    }
    trackEvent("nail_photo.uploaded", {
      replaced: Boolean(owned.imageId),
      sizeBytes: photo.bytes.length,
      width: photo.width,
      height: photo.height,
    });

    return photoResponse(owned.imageId ? 200 : 201, toNailPhoto(saved, request.url, userId, context));
  } catch (error) {
    if (uploadedStorageUrl) {
      // Not linked to anything: remove it so a failed upload leaves no private media behind.
      await deleteNailPhotoBlobs([uploadedStorageUrl], context);
    }
    if (error instanceof InventoryItemNotFoundError) return notFound();
    if (error instanceof NailPhotoInputError) {
      trackEvent("nail_photo.rejected", { status: error.status });
      return { status: error.status, jsonBody: { error: error.message } };
    }
    return internalServerError(context, error, "Failed to save nail photo", "nail-photos.put");
  }
}

async function deleteNailPhoto(
  request: HttpRequest,
  context: InvocationContext,
  userId: number
): Promise<HttpResponseInit> {
  const inventoryItemId = parseInventoryItemId(request.params.inventoryItemId);
  if (inventoryItemId === null) {
    return { status: 400, jsonBody: { error: "Invalid inventory item id" } };
  }

  try {
    const removedStorageUrl = await transaction(async (client) => {
      const locked = await client.query<NailPhotoRow>(`${SELECT_ITEM_WITH_PHOTO}\n  FOR UPDATE OF ui`, [
        inventoryItemId,
        userId,
      ]);
      const current = locked.rows[0];
      if (!current) throw new InventoryItemNotFoundError();
      if (!current.imageId) return null;

      await client.query(
        `DELETE FROM inventory_nail_photo
         WHERE inventory_item_id = $1
           AND image_id = $2`,
        [inventoryItemId, current.imageId]
      );
      const removed = await client.query<{ storageUrl: string }>(
        `DELETE FROM image_asset
         WHERE image_id = $1
           AND owner_type = 'user'
         RETURNING storage_url AS "storageUrl"`,
        [current.imageId]
      );
      return removed.rows[0]?.storageUrl ?? null;
    });

    if (removedStorageUrl) {
      await deleteNailPhotoBlobs([removedStorageUrl], context);
      trackEvent("nail_photo.deleted");
    }
    return { status: 204, headers: NO_STORE_HEADERS };
  } catch (error) {
    if (error instanceof InventoryItemNotFoundError) return notFound();
    return internalServerError(context, error, "Failed to delete nail photo", "nail-photos.delete");
  }
}

app.http("inventory-nail-photo", {
  methods: ["GET", "PUT", "DELETE", "OPTIONS"],
  authLevel: "anonymous",
  route: "inventory/{inventoryItemId}/nail-photo",
  handler: withCors(
    withAuth(async (request, context, userId) => {
      switch (request.method?.toUpperCase()) {
        case "GET":
          return getNailPhoto(request, context, userId);
        case "PUT":
          return putNailPhoto(request, context, userId);
        case "DELETE":
          return deleteNailPhoto(request, context, userId);
        default:
          return { status: 405, jsonBody: { error: "Method not allowed" } };
      }
    })
  ),
});
