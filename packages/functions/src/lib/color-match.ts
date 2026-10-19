import type {
  ColorFamily,
  ColorMatchGroup,
  ExtractedColor,
  MatchScope,
  OKLab,
  Polish,
  PolishMatch,
} from "swatchwatch-shared";
import {
  classifyPaletteColor,
  confidenceForDistance,
  hexToOklab,
  isBackgroundPaletteKind,
  isColorFamily,
  isMatchScope,
  MATCH_SCOPES,
  oklabDistance,
  paletteVibrancyWeight,
  resolveDisplayHex,
} from "swatchwatch-shared";
import sharp from "sharp";
import { validateImageUpload } from "./blob-storage";
import { extractDominantColors } from "./dominant-color";

// ── Confidence thresholds ────────────────────────────────────────────────────
//
// The canonical values live in swatchwatch-shared (color/thresholds.ts) so the
// web app, the API, and vendor↔detected hex reconciliation agree. Re-exported
// here so existing imports keep working.
export {
  HIGH_CONFIDENCE_MAX_DISTANCE,
  MEDIUM_CONFIDENCE_MAX_DISTANCE,
  confidenceForDistance,
} from "swatchwatch-shared";

// ── Request limits / defaults ────────────────────────────────────────────────

export const MATCH_IMAGE_LIMITS = {
  defaultMaxColors: 6,
  maxMaxColors: 10,
  defaultLimit: 20,
  maxLimit: 50,
  defaultPerColorLimit: 5,
  maxPerColorLimit: 20,
  /** Most `finishes` filter values one request may send. */
  maxFinishFilters: 20,
  /** Longest single `finishes` value accepted. */
  maxFinishFilterLength: 64,
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

/** Palette-quality options of a match-image request (#105). All default to false. */
export interface PaletteOptions {
  excludeSkinTones?: boolean;
  excludeBackground?: boolean;
  preferVibrant?: boolean;
}

/**
 * Turn raw extracted buckets (most → least prominent) into the response palette: merge
 * near-duplicates, label each color's `kind` (`classifyPaletteColor`), optionally drop skin /
 * background colors and favor saturated ones, then keep `maxColors` sorted by pixel share.
 *
 * Without options the colors are exactly `mergeSimilarColors(raw, { maxColors })` (plus `kind`).
 * With options, excluded colors do not take a palette slot, and `preferVibrant` picks the
 * entries by `fraction × paletteVibrancyWeight` before re-sorting by `fraction`.
 */
export function buildPalette(
  raw: ExtractedColor[],
  options: PaletteOptions & { maxColors: number }
): ExtractedColor[] {
  const maxColors = Math.max(1, options.maxColors);
  const filtering = Boolean(options.excludeSkinTones || options.excludeBackground || options.preferVibrant);
  const merged = mergeSimilarColors(raw, { maxColors: filtering ? Number.MAX_SAFE_INTEGER : maxColors });

  let palette = merged
    .map((color) => ({ ...color, kind: classifyPaletteColor(color.hex) }))
    .filter(
      (color) =>
        !(options.excludeSkinTones && color.kind === "skin") &&
        !(options.excludeBackground && isBackgroundPaletteKind(color.kind))
    );

  if (options.preferVibrant) {
    palette = palette
      .map((color) => ({ color, weight: color.fraction * paletteVibrancyWeight(color.hex) }))
      .sort((a, b) => b.weight - a.weight)
      .map(({ color }) => color);
  }

  return palette.slice(0, maxColors).sort((a, b) => b.fraction - a.fraction);
}

/**
 * Decode an uploaded image (in memory only) and return its cleaned-up dominant
 * palette (see `buildPalette`). Throws `MatchImageInputError` when the bytes are
 * not a decodable image or the image is unreasonably large.
 */
export async function extractImagePalette(
  bytes: Buffer,
  maxColors: number,
  options: PaletteOptions = {}
): Promise<ExtractedColor[]> {
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

  return buildPalette(raw, { ...options, maxColors });
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

/**
 * Per-color top matches (#105): for each extracted color, the `perColorLimit` closest polishes
 * to that color alone, ascending distance (ties by brand, then name). Groups follow
 * `extractedColors` order; a polish may appear in several groups. Polishes without a usable
 * display hex are skipped. Pure — no I/O.
 */
export function rankColorMatches(
  polishes: Polish[],
  extractedColors: ExtractedColor[],
  perColorLimit: number
): ColorMatchGroup[] {
  const candidates = polishes.flatMap((polish) => {
    const hex = normalizeHex(resolveDisplayHex(polish));
    return hex ? [{ polish, lab: hexToOklab(hex) }] : [];
  });

  const groups: ColorMatchGroup[] = [];
  for (const color of extractedColors) {
    const hex = normalizeHex(color.hex);
    if (!hex) continue;
    const target = hexToOklab(hex);
    const matches = candidates
      .map(({ polish, lab }) => ({ polish, distance: oklabDistance(target, lab) }))
      .sort(
        (a, b) =>
          a.distance - b.distance ||
          a.polish.brand.localeCompare(b.polish.brand) ||
          a.polish.name.localeCompare(b.polish.name)
      )
      .slice(0, Math.max(0, perColorLimit))
      .map(({ polish, distance }) => ({
        polish,
        matchedColor: hex,
        distance: roundTo(distance, 4),
        confidence: confidenceForDistance(distance),
      }));
    groups.push({ hex, matches });
  }
  return groups;
}

// ── Request parsing ──────────────────────────────────────────────────────────

export class MatchImageInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MatchImageInputError";
  }
}

export interface ParsedMatchImageRequest extends Required<PaletteOptions> {
  bytes: Buffer;
  mimeType: string;
  maxColors: number;
  limit: number;
  perColorLimit: number;
  scope: MatchScope;
  /** Raw finish filter values (trimmed, lowercased, deduplicated); canonicalized by the handler. */
  finishes: string[];
  /** Color families in request order, deduplicated (`gray` → `grey`). */
  families: ColorFamily[];
}

function parseOptionalBoolean(value: unknown, field: string): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") throw new MatchImageInputError(`${field} must be a boolean`);
  return value;
}

function parseScope(value: unknown): MatchScope {
  if (value === undefined || value === null) return "owned";
  if (!isMatchScope(value)) {
    throw new MatchImageInputError(`scope must be one of: ${MATCH_SCOPES.join(", ")}`);
  }
  return value;
}

function parseFinishes(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new MatchImageInputError("finishes must be an array of strings");
  if (value.length > MATCH_IMAGE_LIMITS.maxFinishFilters) {
    throw new MatchImageInputError(`finishes accepts at most ${MATCH_IMAGE_LIMITS.maxFinishFilters} values`);
  }
  const out = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") throw new MatchImageInputError("finishes must be an array of strings");
    const normalized = entry.trim().toLowerCase();
    if (!normalized) continue;
    if (normalized.length > MATCH_IMAGE_LIMITS.maxFinishFilterLength) {
      throw new MatchImageInputError("finishes values must be at most 64 characters");
    }
    out.add(normalized);
  }
  return [...out];
}

function parseFamilies(value: unknown): ColorFamily[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new MatchImageInputError("families must be an array of strings");
  const out = new Set<ColorFamily>();
  const invalid: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") throw new MatchImageInputError("families must be an array of strings");
    const normalized = entry.trim().toLowerCase();
    if (!normalized) continue;
    const family = normalized === "gray" ? "grey" : normalized;
    if (isColorFamily(family)) out.add(family);
    else invalid.push(entry.trim());
  }
  if (invalid.length > 0) throw new MatchImageInputError(`Invalid color family: ${invalid.join(", ")}`);
  return [...out];
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
 * optional `maxColors` / `limit` / `perColorLimit`, the `scope` / `finishes` / `families`
 * filters and the palette options. Enforces the shared upload MIME allowlist and
 * 5 MB decoded size limit. Does not decode pixels — callers should still treat
 * a decode failure as a 400.
 */
export function parseMatchImageRequest(body: unknown): ParsedMatchImageRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new MatchImageInputError("Request body must be a JSON object");
  }
  const {
    image,
    maxColors,
    limit,
    perColorLimit,
    scope,
    finishes,
    families,
    excludeSkinTones,
    excludeBackground,
    preferVibrant,
  } = body as Record<string, unknown>;

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
    perColorLimit: parseOptionalInt(
      perColorLimit,
      "perColorLimit",
      1,
      MATCH_IMAGE_LIMITS.maxPerColorLimit,
      MATCH_IMAGE_LIMITS.defaultPerColorLimit
    ),
    scope: parseScope(scope),
    finishes: parseFinishes(finishes),
    families: parseFamilies(families),
    excludeSkinTones: parseOptionalBoolean(excludeSkinTones, "excludeSkinTones"),
    excludeBackground: parseOptionalBoolean(excludeBackground, "excludeBackground"),
    preferVibrant: parseOptionalBoolean(preferVibrant, "preferVibrant"),
  };
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
