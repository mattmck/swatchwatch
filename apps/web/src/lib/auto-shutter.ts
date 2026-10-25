/**
 * Auto-shutter for Rapid Add label, glass and box photos: fire the shutter once the bottle has
 * been brought into the guide and held steady, sharp and well exposed for a moment, so the user
 * only has to hold it up. Everything is measured inside the guide's region of the preview (not the
 * whole frame, whose sharp, steady background used to fire the shot before the bottle arrived),
 * and a sample only counts once that region looks clearly different from when the prompt armed:
 * something has to be brought into the outline. DOM-free so it can be unit tested in Node; the
 * sampling glue (a ~160px luminance thumbnail every `sampleIntervalMs`, cropped with
 * `cropLuminance`) lives in `components/rapid-add/camera-capture.tsx`.
 */
import type { BottleSurface, CaptureFrameType } from "swatchwatch-shared";
import { FRAME_QUALITY_THRESHOLDS, type FrameQualityMetrics } from "./camera";

export const AUTO_SHUTTER_SETTINGS = {
  /** How often the preview is sampled. */
  sampleIntervalMs: 150,
  /** How long every sample must pass before the shutter fires. */
  steadyMs: 1000,
  /** Ignore the first moments after arming, while the user is still bringing the bottle in. */
  armDelayMs: 800,
  /**
   * Largest mean absolute luminance change (0–1) between two samples that still counts as steady.
   * Measured on the guide region, where a hand-held bottle fills the view, so a little looser
   * than a whole-frame threshold would be.
   */
  maxMotion: 0.04,
  /**
   * Smallest mean absolute change (0–1) between the guide region now and when the prompt armed:
   * below it nothing has been brought into the outline yet (the empty scene, or a bottle that was
   * already sitting there), so the shot waits.
   */
  minArrivalChange: 0.08,
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

export type AutoShutterBlocker = "unchanged" | "moving" | "too-dark" | "too-bright" | "blurry" | "empty";

/** The outline the preview shows; each has the region the shutter measures. */
export type AutoShutterGuide = "barcode" | "label" | BottleSurface;

/** A region of the preview in 0–1 coordinates (`x`, `y` = top-left). */
export interface NormalizedRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The part of the preview each guide outlines, a little tighter than the outline so the edges
 * (fingers, background) don't count. The video fills its box with `object-cover`, so the centre of
 * the frame is the centre of the outline on either the portrait or the 16:9 viewfinder.
 */
export const AUTO_SHUTTER_REGIONS: Record<AutoShutterGuide, NormalizedRegion> = {
  barcode: { x: 0.15, y: 0.38, w: 0.7, h: 0.24 },
  label: { x: 0.3, y: 0.15, w: 0.4, h: 0.7 },
  front: { x: 0.3, y: 0.15, w: 0.4, h: 0.7 },
  bottom: { x: 0.28, y: 0.25, w: 0.44, h: 0.5 },
  glass: { x: 0.38, y: 0.38, w: 0.24, h: 0.24 },
  box: { x: 0.22, y: 0.2, w: 0.56, h: 0.6 },
};

/** Copy the `region` of a `width`×`height` luminance buffer (at least 1×1). */
export function cropLuminance(
  luminance: ArrayLike<number>,
  width: number,
  height: number,
  region: NormalizedRegion,
): { luminance: Uint8ClampedArray; width: number; height: number } {
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const left = Math.min(width - 1, Math.floor(clamp(region.x) * width));
  const top = Math.min(height - 1, Math.floor(clamp(region.y) * height));
  const right = Math.max(left + 1, Math.min(width, Math.ceil(clamp(region.x + region.w) * width)));
  const bottom = Math.max(top + 1, Math.min(height, Math.ceil(clamp(region.y + region.h) * height)));
  const w = right - left;
  const h = bottom - top;
  const out = new Uint8ClampedArray(w * h);
  for (let row = 0; row < h; row += 1) {
    for (let col = 0; col < w; col += 1) out[row * w + col] = luminance[(top + row) * width + left + col];
  }
  return { luminance: out, width: w, height: h };
}

export interface AutoShutterSample {
  /** 8-bit luminance of the thumbnail (`rgbaToLuminance`). */
  luminance: ArrayLike<number>;
  metrics: FrameQualityMetrics;
}

export interface AutoShutterState {
  armedAt: number;
  /** The guide region as it looked when the prompt armed (the first sample). */
  reference: ArrayLike<number> | null;
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
  return { armedAt: now, reference: null, previous: null, goodSince: null, fired: false };
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
  /** Change since arming (`luminanceMotion(reference, now)`); 1 when there is no reference to compare. */
  arrivalChange = 1,
): AutoShutterBlocker | null {
  if (metrics.brightness < FRAME_QUALITY_THRESHOLDS.minBrightness) return "too-dark";
  if (metrics.brightness > FRAME_QUALITY_THRESHOLDS.maxBrightness) return "too-bright";
  if (arrivalChange < AUTO_SHUTTER_SETTINGS.minArrivalChange) return "unchanged";
  if (motion > AUTO_SHUTTER_SETTINGS.maxMotion) return "moving";
  if (metrics.contrast < AUTO_SHUTTER_SETTINGS.minContrast) return "empty";
  if (metrics.sharpness < AUTO_SHUTTER_SETTINGS.minSharpness[frameType]) return "blurry";
  return null;
}

/**
 * Feed one preview sample (the guide region); returns the next state and whether to fire the
 * shutter now. The first sample after arming becomes the reference scene and never counts.
 */
export function stepAutoShutter(
  state: AutoShutterState,
  sample: AutoShutterSample,
  now: number,
  frameType: CaptureFrameType,
): { state: AutoShutterState; status: AutoShutterStatus } {
  if (state.fired) {
    return { state, status: { phase: "done", progress: 1, blocker: null } };
  }
  if (!state.reference) {
    return {
      state: { ...state, reference: sample.luminance, previous: sample.luminance, goodSince: null },
      status: { phase: "waiting", progress: 0, blocker: "unchanged" },
    };
  }
  const motion = luminanceMotion(state.previous, sample.luminance);
  const arrivalChange = luminanceMotion(state.reference, sample.luminance);
  const blocker = autoShutterBlocker(sample.metrics, motion, frameType, arrivalChange);
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
  unchanged: "Bring the bottle into the outline (or tap Capture)",
  moving: "Hold steady…",
  "too-dark": "Too dark — move into better light",
  "too-bright": "Too much glare — tilt the bottle a little",
  blurry: "Move a little closer or farther to focus",
  empty: "Fill the box with the bottle",
};
