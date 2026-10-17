import {
  NAIL_PHOTO_ACCEPTED_TYPES,
  NAIL_PHOTO_MAX_EDGE,
  NAIL_PHOTO_MAX_UPLOAD_BYTES,
} from "swatchwatch-shared";
import { downscaleImageFile, MAX_SOURCE_IMAGE_BYTES } from "./image-downscale";

/**
 * Client helpers for the private on-nail photo (#270). The server is the privacy
 * boundary (it re-encodes every upload and strips EXIF/GPS), but re-encoding in
 * the browser first means location metadata never even leaves the device when
 * the browser can decode the file, and keeps uploads small.
 */

/** `accept` attribute for the nail-photo file inputs. */
export const NAIL_PHOTO_INPUT_ACCEPT = NAIL_PHOTO_ACCEPTED_TYPES.join(",");

/** JPEG quality used when re-encoding in the browser. */
const CLIENT_JPEG_QUALITY = 0.9;

/**
 * A user-presentable reason the file cannot be used, or null when it may be
 * uploaded. Checks only what is known before decoding: it must be an image and
 * not absurdly large to decode in the browser.
 */
export function validateNailPhotoFile(file: { type: string; size: number }): string | null {
  if (!file.type || !file.type.toLowerCase().startsWith("image/")) {
    return "Please choose a photo (JPEG, PNG, WebP or HEIC).";
  }
  if (file.size <= 0) {
    return "That file is empty.";
  }
  if (file.size > MAX_SOURCE_IMAGE_BYTES) {
    return `That photo is too large. Please choose one under ${Math.round(MAX_SOURCE_IMAGE_BYTES / (1024 * 1024))} MB.`;
  }
  return null;
}

/**
 * True when the original file may be sent as-is (the server will still strip its
 * metadata): an accepted type within the server's upload limit. Used only when
 * the browser cannot decode the file itself (e.g. HEIC outside Safari).
 */
export function canUploadOriginal(file: { type: string; size: number }): boolean {
  const type = file.type.toLowerCase();
  return (
    (NAIL_PHOTO_ACCEPTED_TYPES as readonly string[]).includes(type) &&
    file.size > 0 &&
    file.size <= NAIL_PHOTO_MAX_UPLOAD_BYTES
  );
}

/** Map an API failure status to a short message for the nail-photo panel. */
export function describeNailPhotoError(status: number | undefined, fallback?: string): string {
  switch (status) {
    case 401:
      return "Your session expired. Please sign in again.";
    case 403:
    case 404:
      return "This polish isn't in your collection, so a photo can't be attached.";
    case 413:
      return `That photo is too large. The limit is ${Math.round(NAIL_PHOTO_MAX_UPLOAD_BYTES / (1024 * 1024))} MB.`;
    case 415:
      return "That file type isn't supported. Please use a JPEG, PNG or WebP photo.";
    case 503:
      return "Photo storage is unavailable right now. Please try again later.";
    default:
      return fallback || "Something went wrong. Please try again.";
  }
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Failed to read the photo."));
    reader.onerror = () => reject(new Error("Failed to read the photo."));
    reader.readAsDataURL(file);
  });
}

/**
 * Turn a picked/captured file into the `image` data URL for the upload API.
 * Re-encodes to a JPEG of at most `NAIL_PHOTO_MAX_EDGE` px in the browser
 * (dropping all metadata and applying the camera orientation); if the browser
 * cannot decode the file, falls back to the original bytes when the server
 * accepts them. Throws a user-presentable Error otherwise.
 */
export async function prepareNailPhotoUpload(file: File): Promise<string> {
  const problem = validateNailPhotoFile(file);
  if (problem) throw new Error(problem);

  try {
    const { dataUrl } = await downscaleImageFile(file, NAIL_PHOTO_MAX_EDGE, CLIENT_JPEG_QUALITY, "image/jpeg");
    return dataUrl;
  } catch (error) {
    if (canUploadOriginal(file)) {
      return readFileAsDataUrl(file);
    }
    throw error instanceof Error ? error : new Error("Couldn't read that photo.");
  }
}
