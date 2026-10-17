/**
 * Camera availability, constraints, error classification and frame-quality metrics for
 * the Rapid Add live camera. DOM-free so it can be unit tested in Node; the browser glue
 * lives in `hooks/use-camera-stream.ts` and `lib/frame-capture.ts`.
 */

export type CameraAvailability = "available" | "insecure-context" | "unsupported";

export interface CameraEnvironment {
  /** `window.isSecureContext` (https, or http://localhost). */
  isSecureContext: boolean;
  /** `typeof navigator.mediaDevices?.getUserMedia === "function"` */
  hasGetUserMedia: boolean;
}

/**
 * Browsers hide `navigator.mediaDevices` on plain-http origins, so an insecure context is
 * reported first: it has a fix (open the https site) that "unsupported" does not.
 */
export function getCameraAvailability(env: CameraEnvironment): CameraAvailability {
  if (!env.isSecureContext) return "insecure-context";
  if (!env.hasGetUserMedia) return "unsupported";
  return "available";
}

export type CameraErrorKind =
  | "permission-denied"
  | "no-camera"
  | "camera-in-use"
  | "insecure-context"
  | "unsupported"
  | "unknown";

/** Map a `getUserMedia` rejection to something the UI can explain and act on. */
export function classifyCameraError(error: unknown): CameraErrorKind {
  const name =
    error && typeof error === "object" && "name" in error && typeof error.name === "string"
      ? error.name
      : "";
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
    case "SecurityError":
      return "permission-denied";
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
    case "ConstraintNotSatisfiedError":
      return "no-camera";
    case "NotReadableError":
    case "TrackStartError":
    case "AbortError":
      return "camera-in-use";
    case "TypeError":
      return "unsupported";
    default:
      return "unknown";
  }
}

export const CAMERA_ERROR_COPY: Record<CameraErrorKind, { title: string; description: string }> = {
  "permission-denied": {
    title: "Camera access is blocked",
    description:
      "Allow camera access for this site in your browser settings, then try again. You can still upload a photo below.",
  },
  "no-camera": {
    title: "No camera found",
    description: "This device doesn't have a camera we can use. Upload a photo of the bottle instead.",
  },
  "camera-in-use": {
    title: "Camera is busy",
    description: "Another app or tab is using the camera. Close it and try again, or upload a photo.",
  },
  "insecure-context": {
    title: "Camera needs a secure connection",
    description: "Browsers only allow the camera on https pages. Open SwatchWatch over https, or upload a photo.",
  },
  unsupported: {
    title: "Camera not supported",
    description: "This browser can't stream the camera. Upload a photo of the bottle instead.",
  },
  unknown: {
    title: "Couldn't start the camera",
    description: "Something went wrong opening the camera. Try again, or upload a photo.",
  },
};

/**
 * Constraints for `getUserMedia`. The first attempt asks for the rear camera at up to
 * 1080p (`ideal`, so front-only laptops still get a stream); the retry drops every
 * constraint for devices that reject the first set with OverconstrainedError.
 */
export function buildCameraConstraints(attempt: "rear" | "any"): MediaStreamConstraints {
  if (attempt === "any") {
    return { video: true, audio: false };
  }
  return {
    audio: false,
    video: {
      facingMode: { ideal: "environment" },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
  };
}

/** True when a failed rear-camera attempt is worth retrying with no constraints. */
export function shouldRetryWithoutConstraints(kind: CameraErrorKind, error: unknown): boolean {
  if (kind !== "no-camera") return false;
  const name =
    error && typeof error === "object" && "name" in error ? String(error.name) : "";
  return name === "OverconstrainedError" || name === "ConstraintNotSatisfiedError";
}

// ---------------------------------------------------------------------------
// Pixels and frame quality
// ---------------------------------------------------------------------------

/** Convert canvas RGBA pixels to an 8-bit luminance buffer (BT.601 weights), as used by zxing and `computeFrameQuality`. */
export function rgbaToLuminance(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Uint8ClampedArray {
  const pixels = width * height;
  const out = new Uint8ClampedArray(pixels);
  for (let i = 0, p = 0; i < pixels; i += 1, p += 4) {
    const alpha = rgba[p + 3] / 255;
    // Composite over white so transparent pixels read as background, not bars.
    const r = rgba[p] * alpha + 255 * (1 - alpha);
    const g = rgba[p + 1] * alpha + 255 * (1 - alpha);
    const b = rgba[p + 2] * alpha + 255 * (1 - alpha);
    out[i] = (r * 299 + g * 587 + b * 114) / 1000;
  }
  return out;
}

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

/**
 * Cheap focus/exposure metrics over a small luminance buffer (0–255 per pixel). Meant for
 * a ~160px-wide thumbnail; it is advisory (sent as frame quality, shown as a hint), never
 * a gate on uploading.
 */
export function computeFrameQuality(
  luminance: ArrayLike<number>,
  width: number,
  height: number,
): FrameQualityMetrics {
  const pixels = width * height;
  if (pixels <= 0 || luminance.length < pixels) {
    return { brightness: 0, contrast: 0, sharpness: 0 };
  }

  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < pixels; i += 1) {
    const v = luminance[i] / 255;
    sum += v;
    sumSq += v * v;
  }
  const brightness = sum / pixels;
  const variance = Math.max(0, sumSq / pixels - brightness * brightness);

  let laplacianSum = 0;
  let samples = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      const lap =
        4 * luminance[i] -
        luminance[i - 1] -
        luminance[i + 1] -
        luminance[i - width] -
        luminance[i + width];
      laplacianSum += Math.abs(lap) / (4 * 255);
      samples += 1;
    }
  }

  return {
    brightness: round4(brightness),
    contrast: round4(Math.sqrt(variance)),
    sharpness: round4(samples > 0 ? laplacianSum / samples : 0),
  };
}

export function assessFrameQuality(metrics: FrameQualityMetrics): FrameQualityWarning[] {
  const warnings: FrameQualityWarning[] = [];
  if (metrics.brightness < FRAME_QUALITY_THRESHOLDS.minBrightness) warnings.push("too-dark");
  if (metrics.brightness > FRAME_QUALITY_THRESHOLDS.maxBrightness) warnings.push("too-bright");
  if (metrics.sharpness < FRAME_QUALITY_THRESHOLDS.minSharpness) warnings.push("blurry");
  return warnings;
}

export const FRAME_QUALITY_WARNING_COPY: Record<FrameQualityWarning, string> = {
  "too-dark": "Looks dark — move into better light.",
  "too-bright": "Looks washed out — avoid glare on the label.",
  blurry: "Looks blurry — hold steady and tap to focus.",
};

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
