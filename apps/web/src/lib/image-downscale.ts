/**
 * Client-side image downscaling for uploads where only color matters
 * (e.g. `POST /api/polishes/match-image`). The server samples images down to
 * ~96px anyway, so shipping a full-resolution phone photo would only waste
 * bandwidth and hit the 5 MB API limit.
 */

/** Longest edge, in px, of the image sent to the match-image endpoint. */
export const MATCH_IMAGE_MAX_EDGE = 640;

/** Upper bound on the original file we'll attempt to decode in the browser. */
export const MAX_SOURCE_IMAGE_BYTES = 25 * 1024 * 1024;

export interface DownscaledImage {
  dataUrl: string;
  width: number;
  height: number;
}

/**
 * Scale `width`×`height` so the longest edge is at most `maxEdge`, preserving
 * aspect ratio. Never upscales; always returns integer dimensions ≥ 1.
 */
export function computeScaledSize(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) {
    return { width: 1, height: 1 };
  }
  const longest = Math.max(width, height);
  const scale = longest > maxEdge ? maxEdge / longest : 1;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Pick the re-encode format: keep PNG for sources that may carry transparency
 * (logos, stickers) so transparent pixels stay ignorable server-side; JPEG for
 * everything else (photos) since it is far smaller.
 */
export function outputMimeTypeFor(sourceType: string): "image/png" | "image/jpeg" {
  const normalized = sourceType.toLowerCase();
  return normalized === "image/png" || normalized === "image/gif" || normalized === "image/webp"
    ? "image/png"
    : "image/jpeg";
}

export async function decodeImage(file: File): Promise<CanvasImageSource & { width: number; height: number }> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      // Fall through to <img> decoding (e.g. Safari quirks with some formats).
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    return Object.assign(img, { width: img.naturalWidth, height: img.naturalHeight });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Decode `file` in the browser, draw it onto a canvas no larger than
 * `maxEdge` on its longest side, and return it as a base64 data URL along
 * with its scaled dimensions.
 *
 * `outputMimeType` defaults to `outputMimeTypeFor(file.type)`; pass
 * `"image/jpeg"` to always re-encode as JPEG (e.g. nail photos).
 *
 * Throws a user-presentable Error when the browser cannot decode the file
 * (e.g. HEIC outside Safari).
 */
export async function downscaleImageFile(
  file: File,
  maxEdge: number = MATCH_IMAGE_MAX_EDGE,
  jpegQuality = 0.85,
  outputMimeType: "image/png" | "image/jpeg" = outputMimeTypeFor(file.type),
): Promise<DownscaledImage> {
  if (!file.type.startsWith("image/")) {
    throw new Error("Please choose an image file.");
  }
  if (file.size > MAX_SOURCE_IMAGE_BYTES) {
    throw new Error("That image is too large. Please choose one under 25 MB.");
  }

  let source: Awaited<ReturnType<typeof decodeImage>>;
  try {
    source = await decodeImage(file);
  } catch {
    throw new Error("Couldn't read that image in this browser. Try a JPEG or PNG.");
  }

  return encodeScaledImage(source, maxEdge, jpegQuality, outputMimeType);
}

/**
 * Draw an already-decoded image onto a canvas no larger than `maxEdge` on its longest side and
 * return it as a base64 data URL (all source metadata is dropped). Closes `source` when it is an
 * `ImageBitmap`. Used by `downscaleImageFile` and by the HEIC converter.
 */
export function encodeScaledImage(
  source: CanvasImageSource & { width: number; height: number },
  maxEdge: number,
  jpegQuality: number,
  mimeType: "image/png" | "image/jpeg",
): DownscaledImage {
  const { width, height } = computeScaledSize(source.width, source.height, maxEdge);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Couldn't process that image in this browser.");
  }

  if (mimeType === "image/jpeg") {
    // JPEG has no alpha; paint white so transparent regions don't turn black.
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, width, height);
  }
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, width, height);
  if ("close" in source && typeof source.close === "function") {
    source.close();
  }

  return { dataUrl: canvas.toDataURL(mimeType, jpegQuality), width, height };
}
