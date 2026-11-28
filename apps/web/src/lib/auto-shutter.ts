/**
 * Auto-shutter for Rapid Add label, glass and box photos: take the photo when the bottle is held
 * still in the guide, so the user only has to hold it up.
 *
 * It cannot see what is in the outline: nothing cheap tells a bottle from a seat or a hand
 * (measured on a phone recording, 2026-11-28: outline-versus-surround contrast and sharpness
 * overlap for all three). So it goes by what the user does, and errs toward not shooting, since
 * the Capture button is always there:
 * - the whole view and the outline's region must both be still for `steadyMs` (a deliberate hold
 *   moves under 0.02 between samples; positioning or turning a bottle moves 0.03 to 0.2);
 * - a label must be sharp and have contrast, with no relaxing over time and no fallback shot;
 * - a hand in the outline (mostly skin tone) is never photographed;
 * - a later side needs time (`armDelayMs`) and a real turn of the bottle (movement of the whole
 *   view since the last photo, and a view that then differs from that photo). The first version
 *   compared only the outline's small region, where a label shifting a little reads as a change,
 *   and so photographed the same side twice a second apart.
 *
 * DOM-free so it can be unit tested in Node; the sampling glue (a ~160px thumbnail every
 * `sampleIntervalMs`) lives in `components/rapid-add/camera-capture.tsx`.
 */
import { DEFAULT_GUIDE_REGIONS, type BottleSurface, type CaptureFrameType } from "swatchwatch-shared";
import { FRAME_QUALITY_THRESHOLDS, type FrameQualityMetrics } from "./camera";

const LABEL_RULES = {
  /**
   * Largest coarse-cell change (0–1) of the outline's region between two samples that still counts
   * as still. The region is small and full of print, so it moves more than the whole view: a held
   * bottom sticker measured 0.015 to 0.054, one being turned in place mostly 0.06 to 0.12 (and
   * those samples also fail the whole-view limit).
   */
  maxMotion: 0.06,
  /** Region brightness outside this is a covered lens or pure glare. */
  minBrightness: 0.1,
  maxBrightness: 0.96,
  /** Below this contrast the region is a blank wall, not a label. */
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
  /** How long the view must be still before the shutter fires: a deliberate hold, not a pause. */
  steadyMs: 900,
  /**
   * The earliest a photo may follow the prompt. For a later side (`changed`, `none`) that is
   * time to see the last photo confirmed, read the prompt and turn the bottle.
   */
  armDelayMs: { empty: 600, changed: 1500, none: 1500 },
  /** Thumbnail pixels per coarse cell: motion is compared on cell means, so jitter of a pixel or two is ignored. */
  motionCell: 6,
  /** Largest coarse-cell change (0–1) of the whole view between two samples that still counts as still. */
  maxSceneMotion: 0.02,
  /**
   * Motion up to this many times the limit is a wobble: a hand holding a bottle still twitches
   * about twice a second (measured). A wobble does not restart the hold if the last one was at
   * least `wobbleEveryMs` ago; a larger movement, or wobbles in a row, do.
   */
  jerkFactor: 1.5,
  wobbleEveryMs: 350,
  /**
   * Motion between two samples at or above this is the bottle (or the phone) being moved: a turn
   * has started. Either the whole view or the outline's region shows it (a bottle that is small
   * in the view barely moves the whole view; a held one twitches up to 0.054 in the region).
   */
  turnMotion: { scene: 0.06, region: 0.12 },
  /**
   * Smallest coarse-cell change (0–1) from the reference (the view when the prompt armed for
   * `empty`, the last photo for `changed`) that counts as a different view; either measure is
   * enough. Measured on a phone: the same side shifting in the hand changes the whole view by up
   * to 0.04 and the region by up to 0.07; a bottle turned to another side changes the view by
   * about 0.10, and the region by 0.11 to 0.32.
   */
  minArrivalChange: { scene: { empty: 0.08, changed: 0.07 }, region: 0.12 },
  /** Once different, the view only counts as back to the reference below this share of `minArrivalChange`. */
  arrivalRelease: 0.5,
  /** At or above this share of skin-tone pixels the outline holds a hand, not a bottle. */
  maxSkin: 0.75,
  /**
   * Per frame type. A glass (color) close-up is a patch of lacquer: it has no edges to be sharp,
   * no contrast, and a black or white polish is as dark or bright as the lens allows, so only
   * stillness is asked of it.
   */
  rules: {
    label: LABEL_RULES,
    barcode: LABEL_RULES,
    other: LABEL_RULES,
    color: { maxMotion: 0.06, minBrightness: 0.02, maxBrightness: 1.01, minContrast: 0, minSharpness: 0 },
  } satisfies Record<CaptureFrameType, AutoShutterRules>,
  /** A prompt that has waited this long for its arrival says what it is waiting for (`AUTO_SHUTTER_STALLED_COPY`). */
  stalledAfterMs: 3000,
} as const;

export type AutoShutterBlocker = "unchanged" | "moving" | "too-dark" | "too-bright" | "blurry" | "empty" | "hand";

/**
 * What must happen before a photo may be taken:
 * - `empty`: the first photo of a bottle. The view must have moved or changed since the prompt
 *   armed (a bottle was brought in); a view that never changes waits for a tap.
 * - `changed`: a later photo. The bottle must have been turned: the whole view moved since the
 *   prompt armed, and now differs from the last photo. It waits as long as that takes: a photo
 *   of the side already taken, sent as the next side, is worse than waiting.
 * - `none`: the same side is asked for again, or a barcode was just read off the bottle: only
 *   the arm delay and the hold apply.
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

/** A luminance buffer and its size. */
export interface LuminanceArea {
  luminance: ArrayLike<number>;
  width: number;
  height: number;
}

export interface AutoShutterSample extends LuminanceArea {
  /** `luminance` is the guide region of the thumbnail (`rgbaToLuminance`, `cropLuminance`); its quality: */
  metrics: FrameQualityMetrics;
  /** The whole visible preview (what the user sees), for movement of the phone or the bottle. */
  scene: LuminanceArea;
  /** 0–1 share of skin-tone pixels in the guide region (`skinFraction`). */
  skin: number;
}

export interface AutoShutterState {
  armedAt: number;
  arrival: AutoShutterArrival;
  /** Coarse cells of the whole view and of the outline's region an arrival is compared with (null: nothing to compare). */
  reference: ArrayLike<number> | null;
  referenceRegion: ArrayLike<number> | null;
  /** Coarse cells of the previous sample's guide region and whole view. */
  previousRegion: ArrayLike<number> | null;
  previousScene: ArrayLike<number> | null;
  /** The whole view has moved (`turnMotion`) since the prompt armed. */
  moved: boolean;
  /** The view differs from the reference (kept until it returns to it, `arrivalRelease`). */
  differs: boolean;
  /** When the current run of still, good samples started, or null. */
  steadySince: number | null;
  /** When the current hold last had a forgiven wobble, or null. */
  lastWobbleAt: number | null;
  fired: boolean;
}

export interface AutoShutterStatus {
  /** `fire` is returned once per arming; after that the gate stays `done`. */
  phase: "waiting" | "steadying" | "fire" | "done";
  /** 0–1 share of `steadyMs` the current hold has lasted. */
  progress: number;
  blocker: AutoShutterBlocker | null;
  /** Nothing has arrived for `stalledAfterMs`: say what it is waiting for (`AUTO_SHUTTER_STALLED_COPY`). */
  stalled: boolean;
}

export interface AutoShutterStep {
  state: AutoShutterState;
  status: AutoShutterStatus;
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

/**
 * 0–1 share of skin-tone pixels in `region` of a `width`-wide RGBA thumbnail (YCbCr box, as
 * common skin detectors use). It also matches beige leather or wood, so it is only used to
 * refuse a view that is almost all skin: a hand held in the outline.
 */
export function skinFraction(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
  region: NormalizedRegion,
): number {
  if (width <= 0 || height <= 0 || rgba.length < width * height * 4) return 0;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const left = Math.min(width - 1, Math.floor(clamp(region.x) * width));
  const top = Math.min(height - 1, Math.floor(clamp(region.y) * height));
  const right = Math.max(left + 1, Math.min(width, Math.ceil(clamp(region.x + region.w) * width)));
  const bottom = Math.max(top + 1, Math.min(height, Math.ceil(clamp(region.y + region.h) * height)));
  let skin = 0;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const i = (y * width + x) * 4;
      const r = rgba[i];
      const g = rgba[i + 1];
      const b = rgba[i + 2];
      const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
      const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
      if (r > 60 && cr > 135 && cr < 180 && cb > 85 && cb < 135) skin += 1;
    }
  }
  return skin / ((right - left) * (bottom - top));
}

export function armAutoShutter(
  now: number,
  opts: {
    arrival?: AutoShutterArrival;
    /** The last photo, for a `changed` arrival: the whole view and the part the current outline covers. */
    reference?: { scene: LuminanceArea; region: LuminanceArea } | null;
  } = {},
): AutoShutterState {
  const arrival = opts.arrival ?? "empty";
  const cells = (a: LuminanceArea | undefined) => {
    const c = a && arrival === "changed" ? coarsenLuminance(a.luminance, a.width, a.height) : null;
    return c && c.length > 0 ? c : null;
  };
  return {
    armedAt: now,
    arrival,
    // With nothing to compare (the last photo was an upload), a `changed` arrival goes by movement alone.
    reference: cells(opts.reference?.scene),
    referenceRegion: cells(opts.reference?.region),
    previousRegion: null,
    previousScene: null,
    moved: false,
    differs: false,
    steadySince: null,
    lastWobbleAt: null,
    fired: false,
  };
}

/**
 * What keeps this sample from counting toward the shot (first blocker wins), or null. `motion`
 * is the guide region's, `sceneMotion` the whole view's.
 */
export function autoShutterBlocker(
  metrics: FrameQualityMetrics,
  motion: number,
  frameType: CaptureFrameType,
  opts: { sceneMotion?: number; skin?: number } = {},
): AutoShutterBlocker | null {
  const rules: AutoShutterRules = AUTO_SHUTTER_SETTINGS.rules[frameType];
  if ((opts.skin ?? 0) >= AUTO_SHUTTER_SETTINGS.maxSkin) return "hand";
  if (metrics.brightness < rules.minBrightness) return "too-dark";
  if (metrics.brightness > rules.maxBrightness) return "too-bright";
  if (motion > rules.maxMotion || (opts.sceneMotion ?? 0) > AUTO_SHUTTER_SETTINGS.maxSceneMotion) return "moving";
  if (metrics.contrast < rules.minContrast) return "empty";
  if (metrics.sharpness < rules.minSharpness) return "blurry";
  return null;
}

const IDLE = { stalled: false } as const;

/**
 * Feed one preview sample; returns the next state and whether to take the photo now. The first
 * sample after arming only sets the scene.
 */
export function stepAutoShutter(
  state: AutoShutterState,
  sample: AutoShutterSample,
  now: number,
  frameType: CaptureFrameType,
): AutoShutterStep {
  if (state.fired) {
    return { state, status: { phase: "done", progress: 1, blocker: null, ...IDLE } };
  }
  const S = AUTO_SHUTTER_SETTINGS;
  const region = coarsenLuminance(sample.luminance, sample.width, sample.height);
  const scene = coarsenLuminance(sample.scene.luminance, sample.scene.width, sample.scene.height);
  if (!state.previousScene || !state.previousRegion) {
    return {
      state: {
        ...state,
        previousRegion: region,
        previousScene: scene,
        reference: state.arrival === "empty" ? scene : state.reference,
        referenceRegion: state.arrival === "empty" ? region : state.referenceRegion,
      },
      status: { phase: "waiting", progress: 0, blocker: state.arrival === "none" ? null : "unchanged", ...IDLE },
    };
  }

  const motion = luminanceMotion(state.previousRegion, region, { ignoreBrightness: true });
  const sceneMotion = luminanceMotion(state.previousScene, scene, { ignoreBrightness: true });
  const moved = state.moved || sceneMotion >= S.turnMotion.scene || motion >= S.turnMotion.region;
  // The view differs from the reference when the whole view or the outline's region does.
  const release = state.differs ? S.arrivalRelease : 1;
  const sceneNeeded = state.arrival === "none" ? 0 : S.minArrivalChange.scene[state.arrival];
  const sceneChange = state.reference ? luminanceMotion(state.reference, scene) : 1;
  const regionChange = state.referenceRegion ? luminanceMotion(state.referenceRegion, region) : 0;
  const differs = sceneChange >= sceneNeeded * release || regionChange >= S.minArrivalChange.region * release;
  // A first photo: something moved or the view changed. A later side: the bottle was turned
  // (it moved) and the view is no longer the last photo's.
  const arrived =
    state.arrival === "none" ? true : state.arrival === "empty" ? moved || differs : moved && differs;
  const base = { ...state, previousRegion: region, previousScene: scene, moved, differs };

  if (!arrived) {
    return {
      state: { ...base, steadySince: null, lastWobbleAt: null },
      status: {
        phase: "waiting",
        progress: 0,
        blocker: "unchanged",
        stalled: now - state.armedAt >= S.stalledAfterMs,
      },
    };
  }

  const blocker = autoShutterBlocker(sample.metrics, motion, frameType, { sceneMotion, skin: sample.skin });
  if (blocker) {
    const rules: AutoShutterRules = S.rules[frameType];
    const wobble =
      blocker === "moving" &&
      motion <= rules.maxMotion * S.jerkFactor &&
      sceneMotion <= S.maxSceneMotion * S.jerkFactor &&
      state.steadySince !== null &&
      (state.lastWobbleAt === null || now - state.lastWobbleAt >= S.wobbleEveryMs);
    if (wobble) {
      // A twitch does not restart the hold, but the shot is never taken on it.
      const progress = Math.min(1, (now - (state.steadySince as number)) / S.steadyMs);
      return { state: { ...base, lastWobbleAt: now }, status: { phase: "steadying", progress, blocker: null, ...IDLE } };
    }
    return {
      state: { ...base, steadySince: null, lastWobbleAt: null },
      status: { phase: "waiting", progress: 0, blocker, ...IDLE },
    };
  }

  const steadySince = state.steadySince ?? now;
  const progress = Math.min(1, (now - steadySince) / S.steadyMs);
  const ready = progress >= 1 && now - state.armedAt >= S.armDelayMs[state.arrival];
  return {
    state: { ...base, steadySince, fired: ready },
    status: { phase: ready ? "fire" : "steadying", progress, blocker: null, ...IDLE },
  };
}

export const AUTO_SHUTTER_BLOCKER_COPY: Record<AutoShutterBlocker, string> = {
  unchanged: "Bring the bottle into the outline, or tap the picture",
  moving: "Hold it still…",
  "too-dark": "Too dark — move into better light",
  "too-bright": "Too much glare — tilt the bottle a little",
  blurry: "Not sharp yet — hold it about 6 in away",
  empty: "Center the bottle in the outline",
  hand: "That looks like a hand. Hold the bottle in the outline.",
};

/**
 * Shown when nothing has arrived for a while. `empty`: the view has not changed since the prompt
 * (the bottle was already there, or is not there yet). `changed`: the bottle has not been turned
 * since the last photo.
 */
export const AUTO_SHUTTER_STALLED_COPY: Record<Exclude<AutoShutterArrival, "none">, string> = {
  empty: "Move the bottle into the outline, or tap the picture.",
  changed: "Turn the bottle to the next side, or tap the picture.",
};
