/**
 * Browser-only helpers that turn a live video frame or an uploaded photo into a capture
 * frame payload: a downscaled JPEG data URL (well under the capture API's 5 MB limit)
 * plus advisory quality metrics.
 */
import { computeFrameQuality, rgbaToLuminance, type FrameQualityMetrics } from "./camera";
import { computeScaledSize, decodeImage, MAX_SOURCE_IMAGE_BYTES } from "./image-downscale";

/** Longest edge of an uploaded capture frame: enough for label OCR, small enough to send. */
export const CAPTURE_FRAME_MAX_EDGE = 1600;
const CAPTURE_FRAME_JPEG_QUALITY = 0.85;
/** Width of the thumbnail the quality metrics are computed on. */
const QUALITY_SAMPLE_WIDTH = 160;

export interface CapturedFrame {
  dataUrl: string;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  metrics: FrameQualityMetrics;
  /** Full-resolution-ish canvas, kept so the caller can run barcode detection on it. */
  canvas: HTMLCanvasElement;
}

type DrawableSource = HTMLVideoElement | HTMLCanvasElement | ImageBitmap | HTMLImageElement;

function drawableSize(source: DrawableSource): { width: number; height: number } {
  if (typeof HTMLVideoElement !== "undefined" && source instanceof HTMLVideoElement) {
    return { width: source.videoWidth, height: source.videoHeight };
  }
  if (typeof HTMLImageElement !== "undefined" && source instanceof HTMLImageElement) {
    return { width: source.naturalWidth, height: source.naturalHeight };
  }
  return { width: source.width, height: source.height };
}

export interface LuminanceSample {
  luminance: Uint8ClampedArray;
  width: number;
  height: number;
  metrics: FrameQualityMetrics;
}

/**
 * Draw `source` into a ~160px-wide thumbnail and measure it. Pass the same `scratch` canvas on
 * every call of a sampling loop to avoid allocating one per frame. Null when nothing can be drawn.
 */
export function sampleLuminance(
  source: DrawableSource,
  scratch: HTMLCanvasElement = document.createElement("canvas"),
): LuminanceSample | null {
  const size = drawableSize(source);
  if (!size.width || !size.height) return null;
  const { width, height } = computeScaledSize(size.width, size.height, QUALITY_SAMPLE_WIDTH);
  if (scratch.width !== width) scratch.width = width;
  if (scratch.height !== height) scratch.height = height;
  const ctx = scratch.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, width, height);
  const { data } = ctx.getImageData(0, 0, width, height);
  const luminance = rgbaToLuminance(data, width, height);
  return { luminance, width, height, metrics: computeFrameQuality(luminance, width, height) };
}

function measureQuality(canvas: HTMLCanvasElement): FrameQualityMetrics {
  return sampleLuminance(canvas)?.metrics ?? { brightness: 0, contrast: 0, sharpness: 0 };
}

/** A part of a frame in 0–1 fractions (`x`, `y` = top-left). */
export interface FrameCrop {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The source pixels a crop covers (whole pixels, at least 1×1, inside the frame). */
export function cropPixels(
  size: { width: number; height: number },
  crop: FrameCrop | null | undefined,
): { sx: number; sy: number; sw: number; sh: number } {
  if (!crop) return { sx: 0, sy: 0, sw: size.width, sh: size.height };
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const sx = Math.min(size.width - 1, Math.floor(clamp(crop.x) * size.width));
  const sy = Math.min(size.height - 1, Math.floor(clamp(crop.y) * size.height));
  const right = Math.max(sx + 1, Math.min(size.width, Math.ceil(clamp(crop.x + crop.w) * size.width)));
  const bottom = Math.max(sy + 1, Math.min(size.height, Math.ceil(clamp(crop.y + crop.h) * size.height)));
  return { sx, sy, sw: right - sx, sh: bottom - sy };
}

/**
 * Snapshot `source` (a playing `<video>`, canvas or bitmap) into a capture frame; with `crop`,
 * only that part of it (`sourceWidth` / `sourceHeight` are then the cropped pixels).
 */
export function captureFrameFromSource(
  source: DrawableSource,
  maxEdge: number = CAPTURE_FRAME_MAX_EDGE,
  crop?: FrameCrop | null,
): CapturedFrame {
  const full = drawableSize(source);
  if (!full.width || !full.height) {
    throw new Error("The camera isn't ready yet. Try again in a moment.");
  }
  const { sx, sy, sw: sourceWidth, sh: sourceHeight } = cropPixels(full, crop);
  const { width, height } = computeScaledSize(sourceWidth, sourceHeight, maxEdge);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Couldn't capture a frame in this browser.");
  }
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, sx, sy, sourceWidth, sourceHeight, 0, 0, width, height);

  return {
    dataUrl: canvas.toDataURL("image/jpeg", CAPTURE_FRAME_JPEG_QUALITY),
    width,
    height,
    sourceWidth,
    sourceHeight,
    metrics: measureQuality(canvas),
    canvas,
  };
}

/** Decode an uploaded photo (EXIF orientation applied) into a capture frame. */
export async function captureFrameFromFile(file: File): Promise<CapturedFrame> {
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
  try {
    return captureFrameFromSource(source as DrawableSource);
  } finally {
    if ("close" in source && typeof source.close === "function") {
      source.close();
    }
  }
}
