import sharp from "sharp";
import { oklabToHex, rgbToOklab, type OKLab } from "swatchwatch-shared";

/**
 * Pixel measurement of a polish color inside a model-localized region.
 *
 * The idea: a vision model is good at *where* (the painted nail, the lacquer in
 * the bottle) and bad at *what value* (an absolute hex), so the model returns a
 * normalized bounding box and this module measures the color inside it from the
 * raw pixels. Everything here is pure with respect to its inputs (sharp only
 * decodes), so it can be unit-tested with synthetic images and later called from
 * ingestion as well as from the eval harness.
 */

/** A bounding box in normalized image coordinates (all 0–1; `x`/`y` is the top-left corner). */
export interface NormalizedBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The same box in integer pixel coordinates after clamping to the image. */
export interface PixelBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** What the model says the box contains. */
export type RegionKind = "nail" | "bottle" | "swatch" | "other";

export const REGION_KINDS: readonly RegionKind[] = ["nail", "bottle", "swatch", "other"];

export interface MeasureRegionColorOptions {
  /**
   * Share of the crop's pixels with the highest OKLAB lightness to discard as
   * specular highlights (0–0.5). Default 0.05.
   */
  highlightFraction?: number;
  /**
   * Pixels with OKLAB L below this are treated as dark edge/outline/shadow
   * pixels and discarded. OKLAB L is cube-root compressed, so 0.2 ≈ sRGB
   * (22,22,22) and a deep burgundy like #670128 sits near L 0.33. Default 0.2.
   */
  darkFloorL?: number;
  /**
   * The dark floor is only applied when the dark pixels are a minority — at most
   * this share of the crop (0–1). Edge/outline pixels are a minority by nature;
   * when most of the crop is below the floor the region IS a dark polish and
   * nothing is dropped. Default 0.25.
   */
  maxDarkFraction?: number;
  /**
   * Measure the median of the darker half (by L) of the remaining pixels instead
   * of all of them. Use for glitter/holo/flake/shimmer finishes so sparkle does
   * not lift the base color. Default false.
   */
  darkerHalf?: boolean;
  /** Longest edge the crop is downscaled to before sampling (bounds work per call). Default 160. */
  sampleSize?: number;
  /** Pixels with alpha below this (0–255) are ignored. Default 16. */
  ignoreAlphaBelow?: number;
}

export interface RegionColorMeasurement {
  /** Uppercase `#RRGGBB` — the per-channel OKLAB median of the kept pixels. */
  hex: string;
  oklab: OKLab;
  /** The crop actually taken, in source-image pixels (bounding box of all crops for multi-box calls). */
  box: PixelBox;
  /** Every crop taken, in source-image pixels. */
  boxes: PixelBox[];
  /** Source image dimensions the box was clamped against. */
  imageWidth: number;
  imageHeight: number;
  pixels: {
    /** Opaque pixels in the (downscaled) crop. */
    sampled: number;
    /** Pixels dropped as specular highlights. */
    highlightsDropped: number;
    /** Pixels dropped by the dark floor. */
    darkDropped: number;
    /** Pixels the median was computed over. */
    measured: number;
  };
  /** OKLAB L above which pixels were discarded as highlights (null when nothing was dropped). */
  highlightCutoffL: number | null;
  /** Whether the dark floor was applied (false when dark pixels were not a minority). */
  darkFloorApplied: boolean;
  /** Whether only the darker half of the remaining pixels was measured. */
  usedDarkerHalf: boolean;
}

const DEFAULTS = {
  highlightFraction: 0.05,
  darkFloorL: 0.2,
  maxDarkFraction: 0.25,
  sampleSize: 160,
  ignoreAlphaBelow: 16,
} as const;

/** Smallest normalized side a box may have after clamping before it is considered useless. */
const MIN_BOX_SIDE = 0.005;

/** Finishes whose sparkle lifts a plain median; these get the darker-half measurement. */
const SPARKLE_FINISH_PATTERN = /glitter|holo|flake|flakie|shimmer|sparkle|micro/i;

/** True when any reported finish is a sparkle finish (glitter, holo, flake, shimmer, …). */
export function isSparkleFinish(finishes: Iterable<unknown> | null | undefined): boolean {
  if (!finishes) return false;
  for (const finish of finishes) {
    if (typeof finish === "string" && SPARKLE_FINISH_PATTERN.test(finish)) return true;
  }
  return false;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Parse `{x, y, w, h}` from untrusted JSON (model output). Accepts numbers or
 * numeric strings and also `x2`/`y2`-style corners when `w`/`h` are missing.
 * Returns null when any coordinate is missing or non-finite; use `clampBox` to
 * validate the geometry.
 */
export function parseNormalizedBox(value: unknown): NormalizedBox | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const x = toFiniteNumber(row.x);
  const y = toFiniteNumber(row.y);
  let w = toFiniteNumber(row.w ?? row.width);
  let h = toFiniteNumber(row.h ?? row.height);
  if (x === null || y === null) return null;
  if (w === null) {
    const x2 = toFiniteNumber(row.x2);
    if (x2 === null) return null;
    w = x2 - x;
  }
  if (h === null) {
    const y2 = toFiniteNumber(row.y2);
    if (y2 === null) return null;
    h = y2 - y;
  }
  return { x, y, w, h };
}

/**
 * Clamp a normalized box to the unit square. Returns null when the box is not a
 * usable region: non-finite values, zero/negative size, entirely outside the
 * image, or thinner than `MIN_BOX_SIDE` after clamping. Values a little over 1
 * (e.g. the model returning 0..100 percentages) are NOT rescaled — a box with
 * x > 1 is simply outside the image.
 */
export function clampBox(box: NormalizedBox | null | undefined): NormalizedBox | null {
  if (!box) return null;
  const { x, y, w, h } = box;
  if (![x, y, w, h].every((v) => Number.isFinite(v))) return null;
  if (w <= 0 || h <= 0) return null;
  if (x >= 0 && y >= 0 && x + w <= 1 && y + h <= 1) {
    return w < MIN_BOX_SIDE || h < MIN_BOX_SIDE ? null : { x, y, w, h };
  }
  const left = Math.max(0, Math.min(1, x));
  const top = Math.max(0, Math.min(1, y));
  const right = Math.max(0, Math.min(1, x + w));
  const bottom = Math.max(0, Math.min(1, y + h));
  const width = right - left;
  const height = bottom - top;
  if (width < MIN_BOX_SIDE || height < MIN_BOX_SIDE) return null;
  return { x: left, y: top, w: width, h: height };
}

/** Convert a clamped normalized box to integer pixels inside a `width`×`height` image (at least 1×1). */
export function boxToPixels(box: NormalizedBox, width: number, height: number): PixelBox {
  const left = Math.min(width - 1, Math.max(0, Math.floor(box.x * width)));
  const top = Math.min(height - 1, Math.max(0, Math.floor(box.y * height)));
  const right = Math.min(width, Math.max(left + 1, Math.ceil((box.x + box.w) * width)));
  const bottom = Math.min(height, Math.max(top + 1, Math.ceil((box.y + box.h) * height)));
  return { left, top, width: right - left, height: bottom - top };
}

function medianOfSorted(values: Float64Array): number {
  const n = values.length;
  if (n === 0) return 0;
  const mid = n >> 1;
  return n % 2 === 1 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}

function channelMedian(pixels: OKLab[], pick: (p: OKLab) => number): number {
  const values = new Float64Array(pixels.length);
  for (let i = 0; i < pixels.length; i += 1) values[i] = pick(pixels[i]);
  values.sort();
  return medianOfSorted(values);
}

/**
 * Crop `box` out of `image`, decode to raw RGB, convert every opaque pixel to
 * OKLAB, discard specular highlights (top `highlightFraction` by L) and very dark
 * edge pixels (L below `darkFloorL`, only when they are a minority of the crop),
 * optionally keep only the darker half (sparkle finishes), and return the
 * per-channel OKLAB median as a hex.
 *
 * Throws when the box is invalid (`clampBox` returns null) or the crop has no
 * opaque pixels.
 */
export async function measureRegionColor(
  image: Buffer,
  box: NormalizedBox,
  options?: MeasureRegionColorOptions
): Promise<RegionColorMeasurement> {
  return measureRegionsColor(image, [box], options);
}

/**
 * Multi-box variant of `measureRegionColor`: pixels from every box are pooled
 * before filtering, so the median spans all regions (e.g. several grid cells
 * the model said are fully covered by polish). Invalid boxes are skipped; it
 * throws only when none is valid. `box` in the result is the bounding box of
 * all crops and `boxes` lists each one.
 */
export async function measureRegionsColor(
  image: Buffer,
  boxes: readonly NormalizedBox[],
  options?: MeasureRegionColorOptions
): Promise<RegionColorMeasurement> {
  const clampedBoxes = boxes.map((box) => clampBox(box)).filter((box): box is NormalizedBox => box !== null);
  if (clampedBoxes.length === 0) {
    throw new Error("Invalid region box: must be a finite, non-empty box inside the image");
  }
  const highlightFraction = Math.max(0, Math.min(0.5, options?.highlightFraction ?? DEFAULTS.highlightFraction));
  const darkFloorL = Math.max(0, Math.min(1, options?.darkFloorL ?? DEFAULTS.darkFloorL));
  const maxDarkFraction = Math.max(0, Math.min(1, options?.maxDarkFraction ?? DEFAULTS.maxDarkFraction));
  const sampleSize = Math.max(1, options?.sampleSize ?? DEFAULTS.sampleSize);
  const ignoreAlphaBelow = options?.ignoreAlphaBelow ?? DEFAULTS.ignoreAlphaBelow;
  const darkerHalf = options?.darkerHalf ?? false;

  const metadata = await sharp(image).metadata();
  const imageWidth = metadata.width ?? 0;
  const imageHeight = metadata.height ?? 0;
  if (imageWidth <= 0 || imageHeight <= 0) {
    throw new Error("Could not read image dimensions");
  }
  const pixelBoxes = clampedBoxes.map((box) => boxToPixels(box, imageWidth, imageHeight));
  // Split the sampling budget across boxes so many small cells cost about as much as one big box.
  const perBoxSize = Math.max(8, Math.round(sampleSize / Math.sqrt(pixelBoxes.length)));

  const pixels: OKLab[] = [];
  for (const pixelBox of pixelBoxes) {
    const { data, info } = await sharp(image)
      .extract(pixelBox)
      .resize(perBoxSize, perBoxSize, { fit: "inside", withoutEnlargement: true })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const channels = info.channels;
    for (let i = 0; i + channels - 1 < data.length; i += channels) {
      const a = channels >= 4 ? data[i + 3] : 255;
      if (a < ignoreAlphaBelow) continue;
      pixels.push(rgbToOklab({ r: data[i], g: data[i + 1], b: data[i + 2] }));
    }
  }
  const left = Math.min(...pixelBoxes.map((b) => b.left));
  const top = Math.min(...pixelBoxes.map((b) => b.top));
  const right = Math.max(...pixelBoxes.map((b) => b.left + b.width));
  const bottom = Math.max(...pixelBoxes.map((b) => b.top + b.height));
  const pixelBox: PixelBox = { left, top, width: right - left, height: bottom - top };
  const sampled = pixels.length;
  if (sampled === 0) {
    throw new Error("Region crop has no opaque pixels");
  }

  // Sort by lightness once; highlights are the top slice, dark edges the bottom.
  pixels.sort((p, q) => p.L - q.L);

  const highlightCount = Math.min(sampled - 1, Math.floor(sampled * highlightFraction));
  let kept = highlightCount > 0 ? pixels.slice(0, sampled - highlightCount) : pixels;
  const highlightCutoffL = highlightCount > 0 ? kept[kept.length - 1].L : null;

  let darkDropped = 0;
  let darkFloorApplied = false;
  if (darkFloorL > 0) {
    let firstBright = 0;
    while (firstBright < kept.length && kept[firstBright].L < darkFloorL) firstBright += 1;
    const remaining = kept.length - firstBright;
    if (firstBright > 0 && remaining > 0 && firstBright <= kept.length * maxDarkFraction) {
      kept = kept.slice(firstBright);
      darkDropped = firstBright;
      darkFloorApplied = true;
    }
  }

  let usedDarkerHalf = false;
  if (darkerHalf && kept.length >= 2) {
    kept = kept.slice(0, Math.ceil(kept.length / 2));
    usedDarkerHalf = true;
  }

  const oklab: OKLab = {
    L: medianOfSorted(Float64Array.from(kept, (p) => p.L)), // already sorted by L
    a: channelMedian(kept, (p) => p.a),
    b: channelMedian(kept, (p) => p.b),
  };

  return {
    hex: oklabToHex(oklab),
    oklab,
    box: pixelBox,
    boxes: pixelBoxes,
    imageWidth,
    imageHeight,
    pixels: {
      sampled,
      highlightsDropped: highlightCount,
      darkDropped,
      measured: kept.length,
    },
    highlightCutoffL,
    darkFloorApplied,
    usedDarkerHalf,
  };
}

export interface GridOverlayOptions {
  /** Grid cells per axis (2–10). Default 4 (labels A1…D4). */
  cells?: number;
  /** Longest edge the overlaid image is resized to (keeps the upload small). Default 768. */
  maxEdge?: number;
}

/**
 * Draw a coarse labeled grid (thin lines, cell labels at each cell's top-left)
 * over a copy of the image and return it as a JPEG. Intended as a localization
 * aid for the vision model; the measurement always uses the original pixels.
 */
export async function drawLabeledGrid(image: Buffer, options?: GridOverlayOptions): Promise<Buffer> {
  const cells = Math.max(2, Math.min(10, Math.round(options?.cells ?? 4)));
  const maxEdge = Math.max(64, options?.maxEdge ?? 768);
  const resized = sharp(image).resize(maxEdge, maxEdge, { fit: "inside", withoutEnlargement: true });
  const { data, info } = await resized.jpeg({ quality: 90 }).toBuffer({ resolveWithObject: true });
  const width = info.width;
  const height = info.height;
  const fontSize = Math.max(10, Math.round(Math.min(width, height) / 30));

  const lines: string[] = [];
  const labels: string[] = [];
  for (let i = 1; i < cells; i += 1) {
    const x = (i * width) / cells;
    const y = (i * height) / cells;
    lines.push(`<line x1="${x}" y1="0" x2="${x}" y2="${height}" />`);
    lines.push(`<line x1="0" y1="${y}" x2="${width}" y2="${y}" />`);
  }
  for (let row = 0; row < cells; row += 1) {
    for (let col = 0; col < cells; col += 1) {
      const label = gridCellLabel(row, col);
      const x = (col * width) / cells + fontSize * 0.3;
      const y = (row * height) / cells + fontSize * 1.1;
      labels.push(
        `<text x="${x}" y="${y}" font-size="${fontSize}" font-family="sans-serif" font-weight="bold" fill="#FFFFFF" stroke="#000000" stroke-width="${Math.max(1, fontSize / 8)}" paint-order="stroke">${label}</text>`
      );
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <g stroke="#FF00FF" stroke-width="1" stroke-opacity="0.8">${lines.join("")}</g>
  ${labels.join("")}
</svg>`;

  return sharp(data)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 90 })
    .toBuffer();
}

/** Label of grid cell (row, col), 0-based: row letter + 1-based column, e.g. `A1`, `C4`. */
export function gridCellLabel(row: number, col: number): string {
  return `${String.fromCharCode(65 + row)}${col + 1}`;
}

/**
 * Normalized box for a grid cell label (`"B3"`, case-insensitive) on a
 * `cells`×`cells` grid, shrunk to its central `inset` share (0–1, default 0.6)
 * so a cell whose edge touches skin or glass still measures mostly polish.
 * Returns null for labels outside the grid.
 */
export function gridCellToBox(label: unknown, cells: number, inset = 0.6): NormalizedBox | null {
  if (typeof label !== "string") return null;
  const match = label.trim().toUpperCase().match(/^([A-Z])\s*(\d{1,2})$/);
  if (!match) return null;
  const row = match[1].charCodeAt(0) - 65;
  const col = Number.parseInt(match[2], 10) - 1;
  if (row < 0 || row >= cells || col < 0 || col >= cells) return null;
  const size = 1 / cells;
  const share = Math.max(0.05, Math.min(1, inset));
  const margin = (size * (1 - share)) / 2;
  return { x: col * size + margin, y: row * size + margin, w: size * share, h: size * share };
}
