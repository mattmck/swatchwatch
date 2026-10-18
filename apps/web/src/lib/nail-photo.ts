import {
  NAIL_PHOTO_ACCEPTED_TYPES,
  NAIL_PHOTO_MAX_EDGE,
  NAIL_PHOTO_MAX_UPLOAD_BYTES,
} from "swatchwatch-shared";
import { downscaleImageFile, encodeScaledImage, MAX_SOURCE_IMAGE_BYTES } from "./image-downscale";
import { decodeHeic, HEIC_EXTENSIONS, isHeicFile, looksLikeHeic } from "./heic-convert";

/**
 * Client helpers for the private on-nail photo (#270). The server is the privacy
 * boundary (it re-encodes every upload and strips EXIF/GPS), but re-encoding in
 * the browser first means location metadata never even leaves the device when
 * the browser can decode the file, and keeps uploads small. HEIC/HEIF (the iPhone default) is
 * converted to JPEG in the browser too (#318), so it never depends on the server's HEIC support.
 */

/**
 * `accept` attribute for the nail-photo file inputs: the API's types plus the HEIC extensions, so
 * pickers that don't map `.heic` to a MIME type (e.g. on Windows) still offer iPhone photos.
 */
export const NAIL_PHOTO_INPUT_ACCEPT = [...NAIL_PHOTO_ACCEPTED_TYPES, ...HEIC_EXTENSIONS].join(",");

/** JPEG quality used when re-encoding in the browser. */
const CLIENT_JPEG_QUALITY = 0.9;

/**
 * A user-presentable reason the file cannot be used, or null when it may be
 * uploaded. Checks only what is known before decoding: it must be an image and
 * not absurdly large to decode in the browser.
 */
export function validateNailPhotoFile(
  file: { type: string; size: number; name?: string },
  isHeic: boolean = looksLikeHeic(file)
): string | null {
  if (!isHeic && !file.type.toLowerCase().startsWith("image/")) {
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
 * the browser cannot decode a non-HEIC file itself.
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

/** Browser steps of `prepareNailPhotoUpload`, injectable for tests. */
export interface NailPhotoPrepareDeps {
  isHeicFile: (file: File) => Promise<boolean>;
  downscaleToJpeg: (file: File) => Promise<string>;
  heicToJpeg: (file: File) => Promise<string>;
  readOriginal: (file: File) => Promise<string>;
}

const browserDeps: NailPhotoPrepareDeps = {
  isHeicFile,
  downscaleToJpeg: async (file) =>
    (await downscaleImageFile(file, NAIL_PHOTO_MAX_EDGE, CLIENT_JPEG_QUALITY, "image/jpeg")).dataUrl,
  heicToJpeg: async (file) =>
    encodeScaledImage(await decodeHeic(file), NAIL_PHOTO_MAX_EDGE, CLIENT_JPEG_QUALITY, "image/jpeg").dataUrl,
  readOriginal: readFileAsDataUrl,
};

/**
 * Turn a picked/captured file into the `image` data URL for the upload API.
 * Re-encodes to a JPEG of at most `NAIL_PHOTO_MAX_EDGE` px in the browser
 * (dropping all metadata and applying the camera orientation):
 *
 * 1. with the browser's own decoder (any format it knows; Safari decodes HEIC itself);
 * 2. for HEIC/HEIF it can't decode (detected by MIME type, extension or file signature), with the
 *    lazily loaded `heic-to` decoder (#318), so no HEIC ever reaches the server;
 * 3. otherwise, the original bytes when the server accepts their type (it re-encodes them).
 *
 * Throws a user-presentable Error when none of these works.
 */
export async function prepareNailPhotoUpload(
  file: File,
  deps: NailPhotoPrepareDeps = browserDeps
): Promise<string> {
  const heic = await deps.isHeicFile(file);
  const problem = validateNailPhotoFile(file, heic);
  if (problem) throw new Error(problem);

  let nativeError: unknown;
  if (file.type.toLowerCase().startsWith("image/")) {
    try {
      return await deps.downscaleToJpeg(file);
    } catch (error) {
      nativeError = error;
    }
  }

  if (heic) {
    // Throws a HeicConversionError with its own message; HEIC is never sent as-is.
    return deps.heicToJpeg(file);
  }

  if (canUploadOriginal(file)) {
    return deps.readOriginal(file);
  }
  throw nativeError instanceof Error ? nativeError : new Error("Couldn't read that photo.");
}
