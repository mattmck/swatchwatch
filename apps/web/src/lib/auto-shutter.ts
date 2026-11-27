/**
 * Auto-shutter for Rapid Add label, glass and box photos: take the photo once the bottle has been
 * brought into the guide and held roughly still for a moment, so the user only has to hold it up.
 * Everything is measured inside the guide's region of the preview (not the whole frame, whose
 * sharp, steady background used to fire the shot before the bottle arrived).
 *
 * It is built to take a photo, not to wait for a perfect one (2026-11-27: on a phone the old gate
 * almost never fired): hand shake is measured on coarse cells so a pixel of jitter on a printed
 * label is not "moving", one wobble is forgiven, a glass (color) shot needs no sharpness or
 * contrast, the checks relax once the bottle has been in the outline a while, and after
 * `bestAfterMs` the best frame seen is taken whatever the checks say.
 *
 * DOM-free so it can be unit tested in Node; the sampling glue (a ~160px luminance thumbnail every
 * `sampleIntervalMs`, cropped with `cropLuminance`) lives in `components/rapid-add/camera-capture.tsx`.
 */
import { DEFAULT_GUIDE_REGIONS, type BottleSurface, type CaptureFrameType } from "swatchwatch-shared";
import { FRAME_QUALITY_THRESHOLDS, type FrameQualityMetrics } from "./camera";

const LABEL_RULES = {
  /**
   * Largest coarse-cell change (0–1) between two samples that still counts as steady. A white
   * sticker on a dark bottle shifting two thumbnail pixels (a normal hand tremor) is about 0.06.
   */
  maxMotion: 0.07,
  /** Region brightness outside this is a covered lens or pure glare. */
  minBrightness: 0.1,
  maxBrightness: 0.96,
  /** Below this contrast the region is a blank wall or a hand, not a label. */
  minContrast: 0.04,
  /** A label needs readable text. */
  minSharpness: FRAME_QUALITY_THRESHOLDS.minSharpness as number,
} as const;

export interface AutoShutterRules {
  maxMotion: number;
  minBrightness: number;
  maxBrightness: number;
  minContrast: number;
  minSharpness: number;
}

export const AUTO_SHUTTER_SETTINGS = {
  /** How often the preview is sampled. */
  sampleIntervalMs: 120,
  /** How long the samples must pass before the shutter fires. */
  steadyMs: 400,
  /** Ignore the first moments after arming, while the user is still bringing the bottle in. */
  armDelayMs: 500,
  /**
   * The arm delay when nothing has to arrive (`none`: the same side is asked for again, or a
   * barcode was just read off the bottle): time to read the prompt and adjust before the shot.
   */
  armDelayNoneMs: 1200,
  /** Thumbnail pixels per coarse cell: motion is compared on cell means, so jitter of a pixel or two is ignored. */
  motionCell: 6,
  /** Motion up to this many times `maxMotion` is a wobble (forgiven once per run); more restarts the run. */
  jerkFactor: 2.5,
  /**
   * Smallest coarse-cell change (0–1) between the guide region now and the reference scene: below
   * it nothing new has been brought into the outline yet, so the shot waits. Both are well above
   * what hand shake alone changes (`maxMotion`), or a bottle held still would count as turned:
   * `empty` compares with the scene before the bottle, `changed` with the last photo.
   */
  minArrivalChange: { empty: 0.1, changed: 0.14 },
  /**
   * Once something has arrived it only counts as gone again below this share of
   * `minArrivalChange`, so a scene near the limit does not flip in and out (which would keep
   * restarting the wait for the best frame).
   */
  arrivalRelease: 0.5,
  /**
   * Per frame type. A glass (color) close-up is a patch of lacquer: it has no edges to be sharp,
   * no contrast, and a black or white polish is as dark or bright as the lens allows, so only
   * stillness (loosely) is asked of it.
   */
  rules: {
    label: LABEL_RULES,
    barcode: LABEL_RULES,
    other: LABEL_RULES,
    color: { maxMotion: 0.12, minBrightness: 0.02, maxBrightness: 1.01, minContrast: 0, minSharpness: 0 },
  } satisfies Record<CaptureFrameType, AutoShutterRules>,
  /** Once the bottle has been in the outline this long the checks relax (`relax`). */
  relaxAfterMs: 1800,
  relax: { motion: 1.6, sharpness: 0.5, steadyMs: 250 },
  /** Once the bottle has been in the outline this long the best frame seen is taken, whatever the checks say. */
  bestAfterMs: 3500,
  /** A kept best frame older than this is stale (the bottle has likely been turned since). */
  bestWindowMs: 2500,
  /** An arrival that has waited this long says what it is waiting for (`AUTO_SHUTTER_STALLED_COPY`). */
  stalledAfterMs: 3000,
  /** An equally good newer sample replaces the kept best frame this often. */
  bestRefreshMs: 500,
} as const;

export type AutoShutterBlocker = "unchanged" | "moving" | "too-dark" | "too-bright" | "blurry" | "empty";

/**
 * What must happen before a photo may be taken:
 * - `empty`: the first photo of a bottle. The first sample is the empty scene; wait until
 *   something is brought into the outline.
 * - `changed`: a later photo. The reference is how the outline looked at the last photo; wait
 *   until it looks different (the bottle was turned). It waits as long as that takes: a shot of
 *   the side already photographed, sent as the next side, is worse than waiting (the Capture
 *   button is always there).
 * - `none`: the bottle is known to be in view (a barcode was just read off it, or the same side
 *   is asked for again): only the arm delay applies.
 */
export type AutoShutterArrival = "empty" | "changed" | "none";

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
 * The default part of the frame per guide, centred (the video fills its box with `object-cover`,
 * so the centre of the frame is the centre of the outline). The camera component measures the
 * outline it actually draws and uses these only when that fails. The bottle surfaces' values are
 * the shared `DEFAULT_GUIDE_REGIONS`, which the capture API uses for photos that come without a
 * region (uploads) and the Expo app draws as its outline.
 */
export const AUTO_SHUTTER_REGIONS: Record<AutoShutterGuide, NormalizedRegion> = {
  barcode: { x: 0.15, y: 0.38, w: 0.7, h: 0.24 },
  label: DEFAULT_GUIDE_REGIONS.front,
  ...DEFAULT_GUIDE_REGIONS,
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
  /** 8-bit luminance of the guide region of the thumbnail (`rgbaToLuminance`, `cropLuminance`). */
  luminance: ArrayLike<number>;
  width: number;
  height: number;
  metrics: FrameQualityMetrics;
}

export interface AutoShutterState {
  armedAt: number;
  arrival: AutoShutterArrival;
  /** Coarse cells of the scene a new arrival is compared with (null: nothing to compare). */
  reference: ArrayLike<number> | null;
  /** Coarse cells of the previous sample. */
  previous: ArrayLike<number> | null;
  /** When the subject was first seen in the outline in the current unbroken run, or null. */
  arrivedAt: number | null;
  /** When the current run of good samples started, or null. */
  goodSince: number | null;
  /** The current run already used its one forgiven wobble. */
  wobbleUsed: boolean;
  /** The best sample since the subject arrived (the caller keeps its frame), or null. */
  best: { score: number; at: number } | null;
  fired: boolean;
}

export interface AutoShutterStatus {
  /** `fire` is returned once per arming; after that the gate stays `done`. */
  phase: "waiting" | "steadying" | "fire" | "done";
  /** 0–1 share of the steady time the current good run has lasted. */
  progress: number;
  blocker: AutoShutterBlocker | null;
  /** The checks have relaxed and the best frame will be taken soon: say so instead of the blocker. */
  settling: boolean;
  /** With `fire`: take the kept best frame (`keep`) instead of the live one. */
  useBest: boolean;
  /** Nothing has arrived in the outline for `stalledAfterMs`: say what it is waiting for (`AUTO_SHUTTER_STALLED_COPY`). */
  stalled: boolean;
}

export interface AutoShutterStep {
  state: AutoShutterState;
  status: AutoShutterStatus;
  /** This sample is the best seen so far: keep its frame in case the fallback needs it. */
  keep: boolean;
}

/** Mean of each `cell`×`cell` block of a `width`×`height` luminance buffer, row by row. */
export function coarsenLuminance(
  luminance: ArrayLike<number>,
  width: number,
  height: number,
  cell: number = AUTO_SHUTTER_SETTINGS.motionCell,
): Float32Array {
  if (width <= 0 || height <= 0 || luminance.length < width * height) return new Float32Array(0);
  const size = Math.max(1, Math.floor(cell));
  const cols = Math.ceil(width / size);
  const rows = Math.ceil(height / size);
  const out = new Float32Array(cols * rows);
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const right = Math.min(width, (col + 1) * size);
      const bottom = Math.min(height, (row + 1) * size);
      let sum = 0;
      let count = 0;
      for (let y = row * size; y < bottom; y += 1) {
        for (let x = col * size; x < right; x += 1) {
          sum += luminance[y * width + x];
          count += 1;
        }
      }
      out[row * cols + col] = count ? sum / count : 0;
    }
  }
  return out;
}

function mean(values: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) sum += values[i];
  return values.length ? sum / values.length : 0;
}

/**
 * Mean absolute difference (0–1) of two equally sized luminance buffers; 1 when they can't be
 * compared. With `ignoreBrightness` each buffer's own mean is removed first, so the camera
 * adjusting its exposure is not movement.
 */
export function luminanceMotion(
  a: ArrayLike<number> | null,
  b: ArrayLike<number>,
  opts: { ignoreBrightness?: boolean } = {},
): number {
  if (!a || a.length !== b.length || b.length === 0) return 1;
  const shift = opts.ignoreBrightness ? mean(b) - mean(a) : 0;
  let sum = 0;
  for (let i = 0; i < b.length; i += 1) sum += Math.abs(b[i] - a[i] - shift);
  return sum / (b.length * 255);
}

export function armAutoShutter(
  now: number,
  opts: { arrival?: AutoShutterArrival; reference?: Pick<AutoShutterSample, "luminance" | "width" | "height"> | null } = {},
): AutoShutterState {
  const wanted = opts.arrival ?? "empty";
  const reference =
    wanted === "changed" && opts.reference
      ? coarsenLuminance(opts.reference.luminance, opts.reference.width, opts.reference.height)
      : null;
  // A `changed` arrival with nothing to compare with can only wait out the arm delay.
  const arrival: AutoShutterArrival = wanted === "changed" && (!reference || reference.length === 0) ? "none" : wanted;
  return {
    armedAt: now,
    arrival,
    reference: arrival === "changed" ? reference : null,
    previous: null,
    arrivedAt: null,
    goodSince: null,
    wobbleUsed: false,
    best: null,
    fired: false,
  };
}

function rulesFor(frameType: CaptureFrameType, relaxed: boolean): AutoShutterRules {
  const rules: AutoShutterRules = AUTO_SHUTTER_SETTINGS.rules[frameType];
  if (!relaxed) return rules;
  return {
    ...rules,
    maxMotion: rules.maxMotion * AUTO_SHUTTER_SETTINGS.relax.motion,
    minSharpness: rules.minSharpness * AUTO_SHUTTER_SETTINGS.relax.sharpness,
  };
}

/** What keeps this sample from counting toward the shot (first blocker wins), or null. */
export function autoShutterBlocker(
  metrics: FrameQualityMetrics,
  motion: number,
  frameType: CaptureFrameType,
  opts: { relaxed?: boolean } = {},
): AutoShutterBlocker | null {
  const rules = rulesFor(frameType, opts.relaxed === true);
  if (metrics.brightness < rules.minBrightness) return "too-dark";
  if (metrics.brightness > rules.maxBrightness) return "too-bright";
  if (motion > rules.maxMotion) return "moving";
  if (metrics.contrast < rules.minContrast) return "empty";
  if (metrics.sharpness < rules.minSharpness) return "blurry";
  return null;
}

/** 0–1: how good a sample is as the photo to fall back on (sharp, still, well exposed). */
export function autoShutterScore(metrics: FrameQualityMetrics, motion: number, frameType: CaptureFrameType): number {
  const rules: AutoShutterRules = AUTO_SHUTTER_SETTINGS.rules[frameType];
  const sharp = rules.minSharpness > 0 ? Math.min(1, metrics.sharpness / (rules.minSharpness * 2)) : 1;
  const still = 1 - Math.min(1, motion / (rules.maxMotion * AUTO_SHUTTER_SETTINGS.jerkFactor));
  const exposed = metrics.brightness >= rules.minBrightness && metrics.brightness <= rules.maxBrightness ? 1 : 0.5;
  return (0.2 + 0.8 * sharp) * (0.3 + 0.7 * still) * exposed;
}

const NOT_FIRING = { settling: false, useBest: false, stalled: false } as const;

/**
 * Feed one preview sample (the guide region); returns the next state, whether to take the photo
 * now, and whether to keep this sample's frame as the best so far.
 */
export function stepAutoShutter(
  state: AutoShutterState,
  sample: AutoShutterSample,
  now: number,
  frameType: CaptureFrameType,
): AutoShutterStep {
  if (state.fired) {
    return { state, status: { phase: "done", progress: 1, blocker: null, ...NOT_FIRING }, keep: false };
  }
  const S = AUTO_SHUTTER_SETTINGS;
  const coarse = coarsenLuminance(sample.luminance, sample.width, sample.height);
  if (!state.previous) {
    // The first sample only sets the scene; with an `empty` arrival it is the scene to move away from.
    return {
      state: { ...state, previous: coarse, reference: state.arrival === "empty" ? coarse : state.reference },
      status: { phase: "waiting", progress: 0, blocker: state.arrival === "none" ? null : "unchanged", ...NOT_FIRING },
      keep: false,
    };
  }

  const change = state.arrival === "none" || !state.reference ? 1 : luminanceMotion(state.reference, coarse);
  const needed = state.arrival === "none" ? 0 : S.minArrivalChange[state.arrival];
  const arrived = change >= (state.arrivedAt === null ? needed : needed * S.arrivalRelease);
  if (!arrived) {
    return {
      state: { ...state, previous: coarse, arrivedAt: null, goodSince: null, wobbleUsed: false, best: null },
      status: {
        phase: "waiting",
        progress: 0,
        blocker: "unchanged",
        ...NOT_FIRING,
        stalled: now - state.armedAt >= S.stalledAfterMs,
      },
      keep: false,
    };
  }

  const arrivedAt = state.arrivedAt ?? now;
  const inView = now - arrivedAt;
  const relaxed = inView >= S.relaxAfterMs;
  const armed = now - state.armedAt >= (state.arrival === "none" ? S.armDelayNoneMs : S.armDelayMs);
  const motion = luminanceMotion(state.previous, coarse, { ignoreBrightness: true });
  const blocker = autoShutterBlocker(sample.metrics, motion, frameType, { relaxed });
  const score = autoShutterScore(sample.metrics, motion, frameType);

  const liveBest = state.best && now - state.best.at <= S.bestWindowMs ? state.best : null;
  // Keep a clearly better sample, and refresh the kept one with an equally good newer sample.
  const keep =
    !liveBest ||
    score > liveBest.score + 0.02 ||
    (score >= liveBest.score - 0.02 && now - liveBest.at >= AUTO_SHUTTER_SETTINGS.bestRefreshMs);
  const best = keep ? { score, at: now } : liveBest;
  // The kept frame is used only when it is clearly better than what the camera shows now.
  const useBest = liveBest !== null && liveBest.score > score + 0.02;
  const base = { ...state, previous: coarse, arrivedAt, best };

  // The fallback: the bottle has been in the outline long enough, so take the best frame seen.
  if (armed && inView >= S.bestAfterMs) {
    return {
      state: { ...base, fired: true },
      status: { phase: "fire", progress: 1, blocker: null, settling: true, useBest, stalled: false },
      keep,
    };
  }

  const steadyMs = relaxed ? S.relax.steadyMs : S.steadyMs;
  if (blocker) {
    const limit = rulesFor(frameType, relaxed).maxMotion * S.jerkFactor;
    if (blocker === "moving" && motion <= limit && state.goodSince !== null && !state.wobbleUsed) {
      // One wobble does not restart the run, but the shot is never taken on it.
      const progress = Math.min(1, (now - state.goodSince) / steadyMs);
      return {
        state: { ...base, wobbleUsed: true },
        status: { phase: "steadying", progress, blocker: null, settling: relaxed, useBest: false, stalled: false },
        keep,
      };
    }
    return {
      state: { ...base, goodSince: null, wobbleUsed: false },
      status: { phase: "waiting", progress: 0, blocker, settling: relaxed, useBest: false, stalled: false },
      keep,
    };
  }

  const goodSince = state.goodSince ?? now;
  const progress = Math.min(1, (now - goodSince) / steadyMs);
  const ready = progress >= 1 && armed;
  return {
    state: { ...base, goodSince, fired: ready },
    status: { phase: ready ? "fire" : "steadying", progress, blocker: null, settling: relaxed, useBest: false, stalled: false },
    keep,
  };
}

export const AUTO_SHUTTER_BLOCKER_COPY: Record<AutoShutterBlocker, string> = {
  unchanged: "Bring the bottle into the outline (or tap Capture)",
  moving: "Hold it still for a moment…",
  "too-dark": "Too dark — move into better light",
  "too-bright": "Too much glare — tilt the bottle a little",
  blurry: "Too close to focus — pull back a little",
  empty: "Center the bottle in the outline",
};

/** Shown instead of a blocker once the checks have relaxed: a photo is coming either way. */
export const AUTO_SHUTTER_SETTLING_COPY = "Taking the best shot…";

/**
 * Shown when the outline has not changed for a while. `empty`: the bottle was already in view
 * when the prompt armed, or is not there yet. `changed`: the outline still shows the side just
 * photographed.
 */
export const AUTO_SHUTTER_STALLED_COPY: Record<Exclude<AutoShutterArrival, "none">, string> = {
  empty: "Move the bottle into the outline, or tap Capture.",
  changed: "Got this side already. Turn the bottle, or tap Capture.",
};
