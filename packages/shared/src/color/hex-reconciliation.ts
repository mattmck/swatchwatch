import type { Polish } from "../types/polish";
import { colorDistance } from "./oklab";
import { MEDIUM_CONFIDENCE_MAX_DISTANCE } from "./thresholds";

/**
 * Reconciliation of a shade's three hex columns into one display hex.
 *
 * `resolveDisplayHex` (types/polish.ts) is the blind precedence
 * vendor > detected > name and stays unchanged for the web app. This module adds
 * the detailed variant that also reports *which* column won, how far apart the
 * vendor and detected hexes are (OKLAB), and whether the shade should be flagged
 * for review.
 */

const HEX_PATTERN = /^#?([0-9a-f]{6})$/i;

/** Normalize to uppercase `#RRGGBB`, or null when not a 6-digit hex color. */
export function normalizeHexColor(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = HEX_PATTERN.exec(value.trim());
  return match ? `#${match[1].toUpperCase()}` : null;
}

/**
 * OKLAB distance between a vendor hex and a detected hex, rounded to 4 decimals
 * (the precision of `shade.hex_agreement NUMERIC(6,4)`). Null unless both are
 * valid 6-digit hex colors. Mirrors the Postgres `hex_oklab_distance()` function
 * that keeps `shade.hex_agreement` current (migration 026).
 */
export function computeHexAgreement(
  vendorHex: string | null | undefined,
  detectedHex: string | null | undefined
): number | null {
  const vendor = normalizeHexColor(vendorHex);
  const detected = normalizeHexColor(detectedHex);
  if (!vendor || !detected) return null;
  return Math.round(colorDistance(vendor, detected) * 10_000) / 10_000;
}

/** Which hex column produced the display hex. */
export type DisplayHexSource = "vendor" | "detected" | "name" | "none";

export interface DisplayHexResolution {
  /** The hex to display, or undefined when the shade has no hex at all. */
  hex: string | undefined;
  /** Column the display hex came from. */
  source: DisplayHexSource;
  /**
   * OKLAB distance between `vendorHex` and `detectedHex` (null when either is
   * missing). Uses the stored `hexAgreement` when the row carries one, otherwise
   * computes it.
   */
  agreement: number | null;
  /** True when the shade should be reviewed: see `reason`. */
  flagged: boolean;
  /**
   * - `disagreement`: vendor and detected hexes differ by more than the threshold
   *   (MEDIUM, 0.10 OKLAB, by default).
   * - `vendor-suspicious`: the caller marked the vendor hex suspicious; detected
   *   hex was preferred when available.
   * - null: nothing to flag.
   */
  reason: "disagreement" | "vendor-suspicious" | null;
}

export interface ResolveDisplayHexOptions {
  /**
   * Set by the caller when `vendorHex` is a known placeholder / CSS-named-color /
   * otherwise untrustworthy value (that heuristic lives in
   * packages/functions/src/lib/suspicious-hex.ts, not here). When true,
   * `detectedHex` is preferred over `vendorHex`.
   */
  vendorHexSuspicious?: boolean;
  /** OKLAB distance above which vendor/detected disagreement is flagged. Default MEDIUM (0.10). */
  disagreementThreshold?: number;
}

type ReconcilablePolish = Pick<Polish, "vendorHex" | "detectedHex" | "nameHex"> &
  Partial<Pick<Polish, "hexAgreement">>;

/**
 * Pure reconciliation of vendor / detected / name hexes.
 *
 * Precedence is unchanged by default (vendor > detected > name, i.e. the same
 * hex `resolveDisplayHex` returns). The result additionally:
 * - reports `source` and `agreement`;
 * - sets `flagged` (reason `disagreement`) when vendor and detected hexes exist
 *   and are further apart than `disagreementThreshold`;
 * - when `options.vendorHexSuspicious` is true, prefers `detectedHex` over
 *   `vendorHex` (precedence becomes detected > vendor > name) and flags the shade
 *   with reason `vendor-suspicious` if the vendor hex still had to be used.
 *
 * A stored `hexAgreement` (from the API) is trusted when present so callers do
 * not recompute OKLAB math for every row; otherwise it is computed here.
 */
export function resolveDisplayHexDetailed(
  polish: ReconcilablePolish,
  options: ResolveDisplayHexOptions = {}
): DisplayHexResolution {
  const vendor = polish.vendorHex || undefined;
  const detected = polish.detectedHex || undefined;
  const name = polish.nameHex || undefined;
  const threshold = options.disagreementThreshold ?? MEDIUM_CONFIDENCE_MAX_DISTANCE;

  const agreement =
    typeof polish.hexAgreement === "number" && Number.isFinite(polish.hexAgreement)
      ? polish.hexAgreement
      : computeHexAgreement(vendor, detected);

  const disagree = agreement !== null && agreement > threshold;

  let hex: string | undefined;
  let source: DisplayHexSource;
  if (options.vendorHexSuspicious && detected) {
    hex = detected;
    source = "detected";
  } else if (vendor) {
    hex = vendor;
    source = "vendor";
  } else if (detected) {
    hex = detected;
    source = "detected";
  } else if (name) {
    hex = name;
    source = "name";
  } else {
    hex = undefined;
    source = "none";
  }

  let reason: DisplayHexResolution["reason"] = null;
  if (disagree) {
    reason = "disagreement";
  } else if (options.vendorHexSuspicious && source === "vendor") {
    reason = "vendor-suspicious";
  }

  return { hex, source, agreement, flagged: reason !== null, reason };
}
