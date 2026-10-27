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

/** Snapshot `source` (a playing `<video>`, canvas or bitmap) into a capture frame. */
export function captureFrameFromSource(
  source: DrawableSource,
  maxEdge: number = CAPTURE_FRAME_MAX_EDGE,
): CapturedFrame {
  const { width: sourceWidth, height: sourceHeight } = drawableSize(source);
  if (!sourceWidth || !sourceHeight) {
    throw new Error("The camera isn't ready yet. Try again in a moment.");
  }
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
  ctx.drawImage(source, 0, 0, width, height);

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
