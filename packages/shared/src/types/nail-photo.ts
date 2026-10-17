/**
 * Private on-nail photo for one of the caller's inventory items (#270).
 *
 * Photos live in the private user-media container and are only ever exposed as
 * owner-scoped `v3` image proxy URLs (`/api/images/v3.*`, #227). Fetching one
 * requires the owner's bearer token, so render it with the web `PrivateImage`
 * component (a plain `<img src>` cannot send the token).
 */

/** Largest decoded upload accepted by `PUT /api/inventory/{id}/nail-photo`, in bytes. */
export const NAIL_PHOTO_MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/**
 * Longest edge (px) the server stores. Larger photos are downscaled (never upscaled);
 * clients may downscale before uploading to save bandwidth.
 */
export const NAIL_PHOTO_MAX_EDGE = 2048;

/**
 * Upload types the API accepts (`data:<type>;base64,…`). HEIC/HEIF is accepted only when the
 * server's image library can decode it; otherwise the upload is refused with 415, so clients
 * should convert HEIC to JPEG first where the browser can decode it.
 */
export const NAIL_PHOTO_ACCEPTED_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
] as const;

export type NailPhotoUploadType = (typeof NAIL_PHOTO_ACCEPTED_TYPES)[number];

export interface NailPhoto {
  /** `user_inventory_item.inventory_item_id` the photo belongs to. */
  inventoryItemId: string;
  /** Shade of that inventory item, when it has one. */
  shadeId: string | null;
  /**
   * Owner-scoped `/api/images/v3.*` URL (expires; refetch the photo for a fresh one). Never a raw
   * blob URL or a public `v2` id. Null when the image proxy cannot sign URLs (misconfiguration).
   */
  imageUrl: string | null;
  /** Stored content type (always re-encoded server-side; currently `image/jpeg`). */
  contentType: string;
  width: number | null;
  height: number | null;
  /** Stored (re-encoded, metadata-free) size in bytes. */
  sizeBytes: number | null;
  createdAt: string;
  updatedAt: string;
}

/** `GET`/`PUT /api/inventory/{inventoryItemId}/nail-photo` response. */
export interface NailPhotoResponse {
  photo: NailPhoto | null;
}

/** `PUT /api/inventory/{inventoryItemId}/nail-photo` body: the photo as a base64 data URL. */
export interface NailPhotoUploadRequest {
  image: string;
}
