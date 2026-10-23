import { hexToOklab, MEDIUM_CONFIDENCE_MAX_DISTANCE, oklabDistance } from "swatchwatch-shared";
import type { HexDetectionResult } from "./ai-color-detection";
import { parseFlagValue } from "./feature-flags";
import { extractPaletteCandidates } from "./palette-pick-detection";

/**
 * Snap a model-reported hex to the nearest color actually measured from the photo.
 *
 * Vision models are good at deciding *which* part of a photo is the polish but
 * poor at reading its absolute color, while a quantized pixel palette of the
 * same photo usually contains a chip very close to the true lacquer color. The
 * model's hex is therefore treated as a pointer into the palette: it is replaced
 * by the nearest measured chip, unless no chip is within `maxDistance` (then the
 * model's hex is kept, since the palette probably missed the polish region).
 *
 * `snapHexToPalette` / `snapDetectionToCandidates` are pure. `snapDetectionToImage`
 * is the production post-processing step every `detected_hex` write path runs
 * after `detectHexWithAzureOpenAI` (ingestion sync detection, the batch-submit
 * fallback, the batch poller apply step and the admin `recalc-hex` endpoint),
 * gated by `HEX_DETECTION_SNAP_ENABLED`. The eval `blind-snap` /
 * `image-select-ai-snap` strategies import the same helpers so they cannot drift.
 */

export interface SnapCandidate {
  hex: string;
  /** Optional chip label / share, carried through to the result for reporting. */
  label?: string;
  fraction?: number;
}

export interface HexSnapResult {
  /** The hex to use: the nearest chip when snapped, otherwise the input hex. */
  hex: string;
  snapped: boolean;
  /** Nearest chip, even when it was too far to snap to (null when there are no valid chips). */
  nearest: SnapCandidate | null;
  /** OKLAB distance from the input hex to the nearest chip (null when there are no valid chips). */
  snapDistance: number | null;
  maxDistance: number;
}

export const DEFAULT_HEX_SNAP_MAX_DISTANCE = MEDIUM_CONFIDENCE_MAX_DISTANCE;

/**
 * `shade.detected_hex_method` for a `vision-direct` detection whose hex was replaced by the
 * nearest measured palette chip. Unsnapped detections keep `vision-direct`, so the two are
 * distinguishable in the hex review queue and the eval exports.
 */
export const HEX_DETECTION_METHOD_VISION_SNAP = "vision-snap";

/** `HEX_SNAP_MAX_DISTANCE` override (OKLAB, > 0); falls back to the MEDIUM threshold. */
export function resolveHexSnapMaxDistance(raw: string | undefined = process.env.HEX_SNAP_MAX_DISTANCE): number {
  const parsed = raw === undefined ? Number.NaN : Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_HEX_SNAP_MAX_DISTANCE;
}

/**
 * `HEX_DETECTION_SNAP_ENABLED` feature flag (default off): only the literal `true`
 * (any case, trimmed) turns the production snap step on. Read at call time, like the
 * other hex-detection knobs, so a setting change applies to the next detection.
 */
export function isHexSnapEnabled(raw: string | undefined = process.env.HEX_DETECTION_SNAP_ENABLED): boolean {
  return parseFlagValue(raw);
}

const HEX_PATTERN = /^#?[0-9a-f]{6}$/i;

/** Pure: snap `hex` to the nearest of `candidates` in OKLAB if it is within `maxDistance`. */
export function snapHexToPalette(
  hex: string,
  candidates: readonly SnapCandidate[],
  maxDistance: number = DEFAULT_HEX_SNAP_MAX_DISTANCE
): HexSnapResult {
  const target = hexToOklab(hex);
  let nearest: SnapCandidate | null = null;
  let snapDistance: number | null = null;
  for (const candidate of candidates) {
    if (!HEX_PATTERN.test(candidate.hex)) continue;
    const distance = oklabDistance(target, hexToOklab(candidate.hex));
    if (snapDistance === null || distance < snapDistance) {
      nearest = candidate;
      snapDistance = distance;
    }
  }
  const snapped = nearest !== null && snapDistance !== null && snapDistance <= maxDistance;
  return {
    hex: snapped ? normalize(nearest!.hex) : hex,
    snapped,
    nearest,
    snapDistance: snapDistance === null ? null : Math.round(snapDistance * 10000) / 10000,
    maxDistance,
  };
}

function normalize(hex: string): string {
  return `#${hex.replace(/^#/, "").toUpperCase()}`;
}

// ── Detection post-processing ────────────────────────────────────────────────

/** The parts of a detection result the snap step reads and rewrites. */
export type SnappableDetection = Pick<HexDetectionResult, "hex" | "method">;

/** Why a detection was returned untouched (`null` when its hex was snapped). */
export type HexSnapSkipReason =
  | "disabled"
  | "no_hex"
  | "image_unavailable"
  | "palette_failed"
  | "no_candidates"
  | "too_far";

export interface SnappedDetection<T extends SnappableDetection> {
  /** The detection to store: `hex` and `method` rewritten when snapped, the input otherwise. */
  detection: T;
  /** Snap diagnostics (null when the palette was never consulted). */
  snap: HexSnapResult | null;
  skipped: HexSnapSkipReason | null;
}

/**
 * Pure: replace `detection.hex` with the nearest measured chip when one is within
 * `maxDistance`, marking the result `vision-snap`. Confidence, model and prompt version
 * are untouched (the prompt did not change; only the hex was post-processed). A detection
 * without a hex, an empty palette or a too-distant nearest chip returns the input as is.
 */
export function snapDetectionToCandidates<T extends SnappableDetection>(
  detection: T,
  candidates: readonly SnapCandidate[],
  maxDistance: number = resolveHexSnapMaxDistance()
): SnappedDetection<T> {
  if (!detection.hex) {
    return { detection, snap: null, skipped: "no_hex" };
  }
  if (candidates.length === 0) {
    return { detection, snap: null, skipped: "no_candidates" };
  }
  const snap = snapHexToPalette(detection.hex, candidates, maxDistance);
  if (!snap.snapped) {
    return { detection, snap, skipped: "too_far" };
  }
  return {
    detection: { ...detection, hex: snap.hex, method: HEX_DETECTION_METHOD_VISION_SNAP },
    snap,
    skipped: null,
  };
}

export type HexSnapLogLevel = "info" | "warn";

export interface SnapDetectionToImageOptions {
  /** Overrides `isHexSnapEnabled()` (tests, or callers that already checked the flag). */
  enabled?: boolean;
  /** Overrides `resolveHexSnapMaxDistance()`. */
  maxDistance?: number;
  /** Short label for log lines (external id, shade id, batch row). */
  label?: string;
  onLog?: (level: HexSnapLogLevel, message: string, data?: Record<string, unknown>) => void;
}

/**
 * Production snap step. `loadImage` must return the bytes of the *same image the model
 * was shown* (the blob behind the proxy URL, the fetched vendor URL, or the decoded data
 * URI); the palette is measured from it with palette-pick's candidate extraction.
 *
 * Never throws and never blocks a write: when the flag is off, the image cannot be
 * loaded, the palette is empty or no chip is close enough, the raw detection is returned
 * (still `vision-direct`) and `skipped` says why.
 */
export async function snapDetectionToImage<T extends SnappableDetection>(
  detection: T,
  loadImage: () => Promise<Buffer | null | undefined>,
  options?: SnapDetectionToImageOptions
): Promise<SnappedDetection<T>> {
  const enabled = options?.enabled ?? isHexSnapEnabled();
  if (!enabled) {
    return { detection, snap: null, skipped: "disabled" };
  }
  if (!detection.hex) {
    return { detection, snap: null, skipped: "no_hex" };
  }

  const prefix = `[hex-snap]${options?.label ? ` ${options.label}` : ""}`;
  const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

  let bytes: Buffer | null | undefined;
  try {
    bytes = await loadImage();
  } catch (error) {
    options?.onLog?.("warn", `${prefix} Image unavailable; keeping the model hex`, {
      modelHex: detection.hex,
      error: describe(error),
    });
    return { detection, snap: null, skipped: "image_unavailable" };
  }
  if (!bytes || bytes.length === 0) {
    options?.onLog?.("warn", `${prefix} Image unavailable; keeping the model hex`, { modelHex: detection.hex });
    return { detection, snap: null, skipped: "image_unavailable" };
  }

  let candidates: SnapCandidate[];
  try {
    candidates = await extractPaletteCandidates(bytes);
  } catch (error) {
    options?.onLog?.("warn", `${prefix} Palette extraction failed; keeping the model hex`, {
      modelHex: detection.hex,
      error: describe(error),
    });
    return { detection, snap: null, skipped: "palette_failed" };
  }

  const result = snapDetectionToCandidates(detection, candidates, options?.maxDistance ?? resolveHexSnapMaxDistance());
  options?.onLog?.("info", `${prefix} ${result.skipped === null ? "Snapped" : `Not snapped (${result.skipped})`}`, {
    modelHex: detection.hex,
    hex: result.detection.hex,
    snapped: result.skipped === null,
    nearestChip: result.snap?.nearest?.hex ?? null,
    snapDistance: result.snap?.snapDistance ?? null,
    maxDistance: result.snap?.maxDistance ?? options?.maxDistance ?? null,
    candidates: candidates.length,
  });
  return result;
}
