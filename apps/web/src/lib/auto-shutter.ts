/**
 * Auto-shutter for Rapid Add label, glass and box photos: fire the shutter once the live
 * preview has been steady, sharp and well exposed for a moment, so the user only has to
 * hold the bottle up. DOM-free so it can be unit tested in Node; the sampling glue (a
 * ~160px luminance thumbnail every `sampleIntervalMs`) lives in `components/rapid-add/camera-capture.tsx`.
 */
import type { CaptureFrameType } from "swatchwatch-shared";
import { FRAME_QUALITY_THRESHOLDS, type FrameQualityMetrics } from "./camera";

export const AUTO_SHUTTER_SETTINGS = {
  /** How often the preview is sampled. */
  sampleIntervalMs: 150,
  /** How long every sample must pass before the shutter fires. */
  steadyMs: 700,
  /** Ignore the first moments after arming, while the user is still bringing the bottle in. */
  armDelayMs: 500,
  /** Largest mean absolute luminance change (0–1) between two samples that still counts as steady. */
  maxMotion: 0.03,
  /** Below this contrast the frame is a blank wall, a hand or the lens cap, not a bottle. */
  minContrast: 0.05,
  /** A label needs readable text; a glass close-up of lacquer has little edge detail. */
  minSharpness: {
    label: FRAME_QUALITY_THRESHOLDS.minSharpness,
    color: FRAME_QUALITY_THRESHOLDS.minSharpness / 2,
    barcode: FRAME_QUALITY_THRESHOLDS.minSharpness,
    other: FRAME_QUALITY_THRESHOLDS.minSharpness,
  } satisfies Record<CaptureFrameType, number>,
} as const;

export type AutoShutterBlocker = "moving" | "too-dark" | "too-bright" | "blurry" | "empty";

export interface AutoShutterSample {
  /** 8-bit luminance of the thumbnail (`rgbaToLuminance`). */
  luminance: ArrayLike<number>;
  metrics: FrameQualityMetrics;
}

export interface AutoShutterState {
  armedAt: number;
  previous: ArrayLike<number> | null;
  /** When the current run of good samples started, or null. */
  goodSince: number | null;
  fired: boolean;
}

export interface AutoShutterStatus {
  /** `fire` is returned once per arming; after that the gate stays `done`. */
  phase: "waiting" | "steadying" | "fire" | "done";
  /** 0–1 share of `steadyMs` the current good run has lasted. */
  progress: number;
  blocker: AutoShutterBlocker | null;
}

export function armAutoShutter(now: number): AutoShutterState {
  return { armedAt: now, previous: null, goodSince: null, fired: false };
}

/** Mean absolute difference (0–1) of two equally sized luminance buffers; 1 when they can't be compared. */
export function luminanceMotion(a: ArrayLike<number> | null, b: ArrayLike<number>): number {
  if (!a || a.length !== b.length || b.length === 0) return 1;
  let sum = 0;
  for (let i = 0; i < b.length; i += 1) sum += Math.abs(a[i] - b[i]);
  return sum / (b.length * 255);
}

/** What keeps this sample from counting toward the shot (first blocker wins), or null. */
export function autoShutterBlocker(
  metrics: FrameQualityMetrics,
  motion: number,
  frameType: CaptureFrameType,
): AutoShutterBlocker | null {
  if (metrics.brightness < FRAME_QUALITY_THRESHOLDS.minBrightness) return "too-dark";
  if (metrics.brightness > FRAME_QUALITY_THRESHOLDS.maxBrightness) return "too-bright";
  if (motion > AUTO_SHUTTER_SETTINGS.maxMotion) return "moving";
  if (metrics.contrast < AUTO_SHUTTER_SETTINGS.minContrast) return "empty";
  if (metrics.sharpness < AUTO_SHUTTER_SETTINGS.minSharpness[frameType]) return "blurry";
  return null;
}

/** Feed one preview sample; returns the next state and whether to fire the shutter now. */
export function stepAutoShutter(
  state: AutoShutterState,
  sample: AutoShutterSample,
  now: number,
  frameType: CaptureFrameType,
): { state: AutoShutterState; status: AutoShutterStatus } {
  if (state.fired) {
    return { state, status: { phase: "done", progress: 1, blocker: null } };
  }
  const motion = luminanceMotion(state.previous, sample.luminance);
  const blocker = autoShutterBlocker(sample.metrics, motion, frameType);
  if (blocker) {
    return {
      state: { ...state, previous: sample.luminance, goodSince: null },
      status: { phase: "waiting", progress: 0, blocker },
    };
  }
  const goodSince = state.goodSince ?? now;
  const progress = Math.min(1, (now - goodSince) / AUTO_SHUTTER_SETTINGS.steadyMs);
  const ready = progress >= 1 && now - state.armedAt >= AUTO_SHUTTER_SETTINGS.armDelayMs;
  return {
    state: { ...state, previous: sample.luminance, goodSince, fired: ready },
    status: { phase: ready ? "fire" : "steadying", progress, blocker: null },
  };
}

export const AUTO_SHUTTER_BLOCKER_COPY: Record<AutoShutterBlocker, string> = {
  moving: "Hold steady…",
  "too-dark": "Too dark — move into better light",
  "too-bright": "Too much glare — tilt the bottle a little",
  blurry: "Move a little closer or farther to focus",
  empty: "Fill the box with the bottle",
};
