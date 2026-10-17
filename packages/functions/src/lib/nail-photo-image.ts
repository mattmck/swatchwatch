import { createHash } from "node:crypto";
import sharp, { type OutputInfo, type SharpOptions } from "sharp";
import pLimit = require("p-limit");
import {
  NAIL_PHOTO_ACCEPTED_TYPES,
  NAIL_PHOTO_MAX_EDGE,
  NAIL_PHOTO_MAX_UPLOAD_BYTES,
} from "swatchwatch-shared";

/**
 * Validation and privacy normalization for private on-nail photos (#270).
 *
 * Every upload is decoded and re-encoded server-side, so nothing from the original file except
 * its pixels survives: EXIF (including GPS location, camera serials and timestamps), XMP, IPTC,
 * ICC profiles and embedded thumbnails are all dropped. The EXIF orientation is applied to the
 * pixels first, so the stored photo displays upright without any metadata. The output is always
 * a baseline sRGB JPEG no larger than `NAIL_PHOTO_MAX_EDGE` on its longest side. Unlike
 * `stripImageMetadata` (capture frames), this fails closed: an image that cannot be decoded is
 * rejected rather than stored as-is.
 */

/**
 * Decoded-pixel cap (decompression-bomb and memory guard). 36 MP is ~108 MB as decoded RGB
 * (~144 MB RGBA) per in-flight upload, and covers 12–24 MP phone photos and 36 MP cameras.
 * 48 MP+ originals are refused (413); the web client downscales to 2048 px before uploading,
 * so only originals it cannot decode itself (e.g. HEIC outside Safari) can hit this.
 */
export const NAIL_PHOTO_MAX_INPUT_PIXELS = 36_000_000;
/**
 * Nail-photo decodes running at once per Functions instance; more wait their turn. Bounds peak
 * memory to roughly this many full-size decodes (plus sharp's own libvips thread pool).
 */
export const NAIL_PHOTO_MAX_CONCURRENT_DECODES = 2;
const decodeLimit = pLimit(NAIL_PHOTO_MAX_CONCURRENT_DECODES);
export const NAIL_PHOTO_OUTPUT_CONTENT_TYPE = "image/jpeg";
const OUTPUT_JPEG_QUALITY = 85;
/** Formats (as reported by the decoder, not the client) we accept. AVIF/HEIC both report `heif`. */
const ACCEPTED_DECODED_FORMATS = new Set(["jpeg", "png", "webp", "heif"]);
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/** A client-side problem with the upload. `status` is the HTTP status to answer with. */
export class NailPhotoInputError extends Error {
  constructor(message: string, public readonly status: 400 | 411 | 413 | 415 = 400) {
    super(message);
    this.name = "NailPhotoInputError";
  }
}

export interface ParsedNailPhotoUpload {
  /** Content type the client declared (validated against the allowlist, then re-checked by decoding). */
  declaredType: string;
  bytes: Buffer;
}

export interface NormalizedNailPhoto {
  bytes: Buffer;
  contentType: typeof NAIL_PHOTO_OUTPUT_CONTENT_TYPE;
  width: number;
  height: number;
  checksumSha256: string;
}

function maxEncodedLength(maxBytes: number): number {
  return Math.ceil(maxBytes / 3) * 4;
}

/**
 * Parse a `data:<type>;base64,<payload>` upload. Checks the declared type against
 * `NAIL_PHOTO_ACCEPTED_TYPES` (415), the encoded and decoded size against
 * `NAIL_PHOTO_MAX_UPLOAD_BYTES` (413, before decoding anything too large), and the base64
 * syntax (400).
 */
export function parseNailPhotoDataUrl(
  value: unknown,
  maxBytes: number = NAIL_PHOTO_MAX_UPLOAD_BYTES
): ParsedNailPhotoUpload {
  if (typeof value !== "string" || value.length === 0) {
    throw new NailPhotoInputError("image must be a base64 data URL (data:image/jpeg;base64,...)");
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith("data:")) {
    throw new NailPhotoInputError("image must be a base64 data URL (data:image/jpeg;base64,...)");
  }
  const commaIndex = trimmed.indexOf(",");
  if (commaIndex <= 5) {
    throw new NailPhotoInputError("Invalid image data URL format");
  }

  const metaParts = trimmed.slice(5, commaIndex).split(";").map((part) => part.trim()).filter(Boolean);
  const declaredType = (metaParts[0] || "").toLowerCase();
  if (!(NAIL_PHOTO_ACCEPTED_TYPES as readonly string[]).includes(declaredType)) {
    throw new NailPhotoInputError(
      `Unsupported image type: ${declaredType || "unknown"}. Allowed: ${NAIL_PHOTO_ACCEPTED_TYPES.join(", ")}`,
      415
    );
  }
  if (!metaParts.slice(1).some((part) => part.toLowerCase() === "base64")) {
    throw new NailPhotoInputError("Data URL images must be base64 encoded");
  }

  const payload = trimmed.slice(commaIndex + 1).replace(/\s/g, "");
  if (payload.length === 0) {
    throw new NailPhotoInputError("Image payload is empty");
  }
  if (payload.length > maxEncodedLength(maxBytes)) {
    throw new NailPhotoInputError(tooLargeMessage(maxBytes), 413);
  }
  if (payload.length % 4 !== 0 || !BASE64_PATTERN.test(payload)) {
    throw new NailPhotoInputError("Image payload must be valid base64");
  }

  const bytes = Buffer.from(payload, "base64");
  if (bytes.length === 0) {
    throw new NailPhotoInputError("Image payload is empty");
  }
  if (bytes.length > maxBytes) {
    throw new NailPhotoInputError(tooLargeMessage(maxBytes), 413);
  }
  return { declaredType, bytes };
}

function tooLargeMessage(maxBytes: number): string {
  return `Image too large: the limit is ${(maxBytes / (1024 * 1024)).toFixed(0)} MB`;
}

export interface NormalizeNailPhotoOptions {
  maxInputPixels?: number;
  maxEdge?: number;
}

/**
 * Decode, auto-orient, downscale and re-encode a photo as a metadata-free sRGB JPEG.
 *
 * @throws NailPhotoInputError (415) when the bytes are not a decodable JPEG/PNG/WebP/HEIF image
 *   (including HEIC variants this build of libvips cannot decode), (413) when the decoded image
 *   exceeds `maxInputPixels`.
 * @throws Error when the re-encoded output still carries metadata (never stored; fail closed).
 * At most `NAIL_PHOTO_MAX_CONCURRENT_DECODES` calls decode at once; the rest queue.
 */
export function normalizeNailPhoto(
  bytes: Buffer,
  options: NormalizeNailPhotoOptions = {}
): Promise<NormalizedNailPhoto> {
  return decodeLimit(() => normalizeNailPhotoNow(bytes, options));
}

async function normalizeNailPhotoNow(
  bytes: Buffer,
  options: NormalizeNailPhotoOptions
): Promise<NormalizedNailPhoto> {
  const maxInputPixels = options.maxInputPixels ?? NAIL_PHOTO_MAX_INPUT_PIXELS;
  const maxEdge = options.maxEdge ?? NAIL_PHOTO_MAX_EDGE;
  const decodeOptions: SharpOptions = {
    failOn: "error",
    // Enforced by libvips while decoding as well as by the explicit header check below.
    limitInputPixels: maxInputPixels,
    animated: false,
  };

  let format: string | undefined;
  let pixels = 0;
  try {
    // Header only (no pixel decode), so the pixel cap is checked below for a clean 413.
    const metadata = await sharp(bytes, { ...decodeOptions, limitInputPixels: false }).metadata();
    format = metadata.format;
    pixels = (metadata.width ?? 0) * (metadata.height ?? 0);
  } catch {
    throw new NailPhotoInputError("The file is not a supported image (JPEG, PNG, WebP or HEIC)", 415);
  }
  if (!format || !ACCEPTED_DECODED_FORMATS.has(format)) {
    throw new NailPhotoInputError("The file is not a supported image (JPEG, PNG, WebP or HEIC)", 415);
  }
  if (pixels > maxInputPixels) {
    throw new NailPhotoInputError("Image dimensions are too large", 413);
  }

  let output: { data: Buffer; info: OutputInfo };
  try {
    output = await sharp(bytes, decodeOptions)
      // Bake the EXIF orientation into the pixels before the metadata is discarded.
      .rotate()
      .resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true })
      // JPEG has no alpha: composite transparent areas onto white instead of black.
      .flatten({ background: "#ffffff" })
      .toColourspace("srgb")
      // No withMetadata()/keepExif()/keepIccProfile(): sharp writes no EXIF, XMP, IPTC or ICC.
      .jpeg({ quality: OUTPUT_JPEG_QUALITY, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
  } catch {
    const heif = format === "heif";
    throw new NailPhotoInputError(
      heif
        ? "This HEIC/HEIF photo could not be decoded on the server. Please upload it as JPEG."
        : "The image could not be decoded",
      415
    );
  }

  await assertNoMetadata(output.data);

  return {
    bytes: output.data,
    contentType: NAIL_PHOTO_OUTPUT_CONTENT_TYPE,
    width: output.info.width,
    height: output.info.height,
    checksumSha256: createHash("sha256").update(output.data).digest("hex"),
  };
}

/** Fail closed if the encoder ever starts copying metadata through (e.g. a sharp default change). */
async function assertNoMetadata(bytes: Buffer): Promise<void> {
  const metadata = await sharp(bytes).metadata();
  const leaked = [
    metadata.exif ? "exif" : null,
    metadata.xmp ? "xmp" : null,
    metadata.iptc ? "iptc" : null,
    metadata.icc ? "icc" : null,
    metadata.orientation && metadata.orientation !== 1 ? "orientation" : null,
  ].filter(Boolean);
  if (leaked.length > 0) {
    throw new Error(`Nail photo re-encode kept metadata (${leaked.join(", ")}); refusing to store it`);
  }
}
