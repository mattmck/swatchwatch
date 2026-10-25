/**
 * Frame-quality thresholds shared by the web camera (which measures a frame on device) and the
 * capture API (which reads those measurements back from a stored frame's `quality`). Pure.
 */

export interface FrameQualityMetrics {
  /** Mean luminance, 0 (black) – 1 (white). */
  brightness: number;
  /** Luminance standard deviation, 0 – ~0.5. */
  contrast: number;
  /** Mean absolute Laplacian response, 0 – 1; low values mean a soft/blurry frame. */
  sharpness: number;
}

export type FrameQualityWarning = "too-dark" | "too-bright" | "blurry";

export const FRAME_QUALITY_THRESHOLDS = {
  minBrightness: 0.15,
  maxBrightness: 0.92,
  minSharpness: 0.012,
} as const;

export function assessFrameQuality(metrics: FrameQualityMetrics): FrameQualityWarning[] {
  const warnings: FrameQualityWarning[] = [];
  if (metrics.brightness < FRAME_QUALITY_THRESHOLDS.minBrightness) warnings.push("too-dark");
  if (metrics.brightness > FRAME_QUALITY_THRESHOLDS.maxBrightness) warnings.push("too-bright");
  if (metrics.sharpness < FRAME_QUALITY_THRESHOLDS.minSharpness) warnings.push("blurry");
  return warnings;
}

/**
 * Warnings for a capture frame's `quality` object. Reads the numeric `brightness` and
 * `sharpness` the web camera sends; returns `[]` when either is missing or not a finite number
 * (mobile frames carry none), so a frame without metrics is never judged.
 */
export function frameQualityWarningsFromQuality(
  quality: Record<string, unknown> | null | undefined,
): FrameQualityWarning[] {
  if (!quality) return [];
  const { brightness, sharpness } = quality;
  if (typeof brightness !== "number" || !Number.isFinite(brightness)) return [];
  if (typeof sharpness !== "number" || !Number.isFinite(sharpness)) return [];
  return assessFrameQuality({ brightness, contrast: 0, sharpness });
}
