import { hexToOklab, MEDIUM_CONFIDENCE_MAX_DISTANCE, oklabDistance } from "swatchwatch-shared";

/**
 * Snap a model-reported hex to the nearest color actually measured from the photo.
 *
 * Vision models are good at deciding *which* part of a photo is the polish but
 * poor at reading its absolute color, while a quantized pixel palette of the
 * same photo usually contains a chip very close to the true lacquer color. The
 * model's hex is therefore treated as a pointer into the palette: it is replaced
 * by the nearest measured chip, unless no chip is within `maxDistance` (then the
 * model's hex is kept, since the palette probably missed the polish region).
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

/** `HEX_SNAP_MAX_DISTANCE` override (OKLAB, > 0); falls back to the MEDIUM threshold. */
export function resolveHexSnapMaxDistance(raw: string | undefined = process.env.HEX_SNAP_MAX_DISTANCE): number {
  const parsed = raw === undefined ? Number.NaN : Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_HEX_SNAP_MAX_DISTANCE;
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
