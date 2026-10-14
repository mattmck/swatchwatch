import type {
  ExtractedColor,
  MatchConfidence,
  OKLab,
  Polish,
  PolishMatch,
} from "swatchwatch-shared";
import { hexToOklab, oklabDistance, resolveDisplayHex } from "swatchwatch-shared";
import sharp from "sharp";
import { validateImageUpload } from "./blob-storage";
import { extractDominantColors } from "./dominant-color";

// ── Confidence thresholds ────────────────────────────────────────────────────
//
// Distances are plain Euclidean distance in OKLAB (the same `colorDistance`
// math the web app uses). On that scale black↔white is 1.0, and ~0.02 is
// roughly a just-noticeable difference.
//
// - HIGH (≤ 0.05): ~2–3 JNDs. Side by side you can tell them apart, but they
//   read as "the same color", which is about as tight as a phone photo (white
//   balance, lighting, compression) vs. a catalog hex can be expected to get.
// - MEDIUM (≤ 0.10): same hue family, visibly different shade. Brackets the
//   0.075 "you already have this" threshold used by /polishes/search.
// - LOW (> 0.10): nearest available, but a noticeably different color.
//
// Tune these here; nothing else hard-codes them.
export const HIGH_CONFIDENCE_MAX_DISTANCE = 0.05;
export const MEDIUM_CONFIDENCE_MAX_DISTANCE = 0.1;

/** Map an OKLAB distance to a confidence bucket. */
export function confidenceForDistance(distance: number): MatchConfidence {
  if (distance <= HIGH_CONFIDENCE_MAX_DISTANCE) return "high";
  if (distance <= MEDIUM_CONFIDENCE_MAX_DISTANCE) return "medium";
  return "low";
}

// ── Request limits / defaults ────────────────────────────────────────────────

export const MATCH_IMAGE_LIMITS = {
  defaultMaxColors: 6,
  maxMaxColors: 10,
  defaultLimit: 20,
  maxLimit: 50,
  /** Reject images whose decoded size would exceed this many pixels (decompression-bomb guard). */
  maxInputPixels: 40_000_000,
  /**
   * Extracted colors closer than this (OKLAB) are merged into one palette entry.
   * The raw extractor buckets per RGB channel, so a single photographed surface
   * often lands in several neighbouring buckets; merging keeps the palette
   * meaningful instead of six near-identical beiges.
   */
  paletteMergeDistance: 0.04,
  /** Palette entries covering less than this share of the image are dropped as noise. */
  minColorFraction: 0.01,
} as const;

// ── Hex helpers ──────────────────────────────────────────────────────────────
// OKLAB math (hexToOklab / oklabDistance) comes from swatchwatch-shared, the
// same implementation the web app uses, so distances agree across client and API.

const HEX_PATTERN = /^#?([0-9a-f]{6})$/i;

/** Normalize to uppercase `#RRGGBB`, or null if not a 6-digit hex color. */
export function normalizeHex(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = HEX_PATTERN.exec(value.trim());
  return match ? `#${match[1].toUpperCase()}` : null;
}

// ── Palette cleanup ──────────────────────────────────────────────────────────

/**
 * Collapse perceptually near-identical colors and drop tiny ones.
 *
 * Input is expected most → least prominent. Each color either merges into the
 * first already-kept color within `mergeDistance` (adding its fraction; the
 * more prominent hex wins) or becomes a new palette entry. Output is re-sorted
 * by merged fraction and truncated to `maxColors`.
 */
export function mergeSimilarColors(
  colors: ExtractedColor[],
  options: { maxColors: number; mergeDistance?: number; minFraction?: number }
): ExtractedColor[] {
  const mergeDistance = options.mergeDistance ?? MATCH_IMAGE_LIMITS.paletteMergeDistance;
  const minFraction = options.minFraction ?? MATCH_IMAGE_LIMITS.minColorFraction;

  const kept: Array<{ hex: string; fraction: number; lab: OKLab }> = [];
  for (const color of colors) {
    const hex = normalizeHex(color.hex);
    if (!hex) continue;
    const lab = hexToOklab(hex);
    const target = kept.find((entry) => oklabDistance(entry.lab, lab) < mergeDistance);
    if (target) {
      target.fraction += color.fraction;
    } else {
      kept.push({ hex, fraction: color.fraction, lab });
    }
  }

  return kept
    .filter((entry) => entry.fraction >= minFraction)
    .sort((a, b) => b.fraction - a.fraction)
    .slice(0, Math.max(1, options.maxColors))
    .map(({ hex, fraction }) => ({ hex, fraction: roundTo(fraction, 4) }));
}

/**
 * Decode an uploaded image (in memory only) and return its cleaned-up dominant
 * palette. Throws `MatchImageInputError` when the bytes are not a decodable
 * image or the image is unreasonably large.
 */
export async function extractImagePalette(bytes: Buffer, maxColors: number): Promise<ExtractedColor[]> {
  let width: number | undefined;
  let height: number | undefined;
  try {
    ({ width, height } = await sharp(bytes).metadata());
  } catch {
    throw new MatchImageInputError("Could not decode image");
  }
  if (!width || !height) {
    throw new MatchImageInputError("Could not decode image");
  }
  if (width * height > MATCH_IMAGE_LIMITS.maxInputPixels) {
    throw new MatchImageInputError(
      `Image dimensions too large (${width}x${height}); downscale before uploading`
    );
  }

  let raw: ExtractedColor[];
  try {
    // Over-fetch raw buckets so merging near-duplicates still leaves enough
    // distinct colors to fill the requested palette.
    raw = await extractDominantColors(bytes, { maxColors: maxColors * 6, sampleSize: 96 });
  } catch {
    throw new MatchImageInputError("Could not decode image");
  }

  return mergeSimilarColors(raw, { maxColors });
}

// ── Matching ─────────────────────────────────────────────────────────────────

export interface RankPolishMatchesResult {
  matches: PolishMatch[];
  /** Polishes that had a usable hex and were scored. */
  candidateCount: number;
}

/**
 * Score each polish by its minimum OKLAB distance to any extracted color and
 * return the closest `limit`, sorted ascending (ties broken by brand, then name).
 * Polishes without a usable display hex are skipped. Pure — no I/O.
 */
export function rankPolishMatches(
  polishes: Polish[],
  extractedColors: ExtractedColor[],
  limit: number
): RankPolishMatchesResult {
  const targets = extractedColors
    .map((color) => normalizeHex(color.hex))
    .filter((hex): hex is string => hex !== null)
    .map((hex) => ({ hex, lab: hexToOklab(hex) }));

  if (targets.length === 0) {
    return { matches: [], candidateCount: 0 };
  }

  const scored: PolishMatch[] = [];
  for (const polish of polishes) {
    const hex = normalizeHex(resolveDisplayHex(polish));
    if (!hex) continue;
    const lab = hexToOklab(hex);

    let best = targets[0];
    let bestDistance = Infinity;
    for (const target of targets) {
      const d = oklabDistance(target.lab, lab);
      if (d < bestDistance) {
        bestDistance = d;
        best = target;
      }
    }

    scored.push({
      polish,
      matchedColor: best.hex,
      distance: roundTo(bestDistance, 4),
      confidence: confidenceForDistance(bestDistance),
    });
  }

  scored.sort(
    (a, b) =>
      a.distance - b.distance ||
      a.polish.brand.localeCompare(b.polish.brand) ||
      a.polish.name.localeCompare(b.polish.name)
  );

  return {
    matches: scored.slice(0, Math.max(0, limit)),
    candidateCount: scored.length,
  };
}

// ── Request parsing ──────────────────────────────────────────────────────────

export class MatchImageInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MatchImageInputError";
  }
}

export interface ParsedMatchImageRequest {
  bytes: Buffer;
  mimeType: string;
  maxColors: number;
  limit: number;
}

function parseOptionalInt(
  value: unknown,
  field: string,
  min: number,
  max: number,
  fallback: number
): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new MatchImageInputError(`${field} must be an integer`);
  }
  if (value < min || value > max) {
    throw new MatchImageInputError(`${field} must be between ${min} and ${max}`);
  }
  return value;
}

/**
 * Validate a match-image request body: a base64 `data:image/...` URL plus
 * optional `maxColors` / `limit`. Enforces the shared upload MIME allowlist and
 * 5 MB decoded size limit. Does not decode pixels — callers should still treat
 * a decode failure as a 400.
 */
export function parseMatchImageRequest(body: unknown): ParsedMatchImageRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new MatchImageInputError("Request body must be a JSON object");
  }
  const { image, maxColors, limit } = body as Record<string, unknown>;

  if (typeof image !== "string" || image.trim().length === 0) {
    throw new MatchImageInputError("image is required (base64 data URL)");
  }

  const trimmed = image.trim();
  if (!trimmed.startsWith("data:")) {
    throw new MatchImageInputError("image must be a base64 data URL (data:image/...;base64,...)");
  }

  const commaIndex = trimmed.indexOf(",");
  if (commaIndex <= 5) {
    throw new MatchImageInputError("Invalid image data URL format");
  }

  const metaParts = trimmed.slice(5, commaIndex).split(";").filter(Boolean);
  const declaredType = (metaParts[0] || "").toLowerCase();
  if (!declaredType.startsWith("image/")) {
    throw new MatchImageInputError("image must have an image/* MIME type");
  }
  if (!metaParts.includes("base64")) {
    throw new MatchImageInputError("image data URL must be base64 encoded");
  }

  const payload = trimmed.slice(commaIndex + 1).replace(/\s/g, "");
  if (payload.length === 0 || payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) {
    throw new MatchImageInputError("image payload must be valid base64");
  }

  const bytes = Buffer.from(payload, "base64");
  let mimeType: string;
  try {
    mimeType = validateImageUpload(declaredType, bytes.length);
  } catch (error) {
    throw new MatchImageInputError(error instanceof Error ? error.message : "Invalid image");
  }

  return {
    bytes,
    mimeType,
    maxColors: parseOptionalInt(
      maxColors,
      "maxColors",
      1,
      MATCH_IMAGE_LIMITS.maxMaxColors,
      MATCH_IMAGE_LIMITS.defaultMaxColors
    ),
    limit: parseOptionalInt(
      limit,
      "limit",
      1,
      MATCH_IMAGE_LIMITS.maxLimit,
      MATCH_IMAGE_LIMITS.defaultLimit
    ),
  };
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
