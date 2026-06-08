import sharp from "sharp";

/**
 * A dominant color extracted from an image, with the share of sampled pixels it
 * represents. `hex` is an uppercase `#RRGGBB` string (the average color of the
 * quantization bucket, which reads more naturally than a bucket corner).
 */
export interface DominantColor {
  hex: string;
  fraction: number;
}

export interface ExtractDominantColorsOptions {
  /** Max colors to return, ordered by prominence. Default 5. */
  maxColors?: number;
  /** Longest-edge size the image is downscaled to before sampling. Default 64. */
  sampleSize?: number;
  /**
   * Bits of precision kept per channel when bucketing similar colors together
   * (1–8). Lower merges more aggressively. Default 4 (16 levels per channel).
   */
  quantizeBits?: number;
  /** Pixels with alpha below this (0–255) are ignored. Default 16. */
  ignoreAlphaBelow?: number;
}

const DEFAULTS = {
  maxColors: 5,
  sampleSize: 64,
  quantizeBits: 4,
  ignoreAlphaBelow: 16,
} as const;

function toHex(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value)))
    .toString(16)
    .padStart(2, "0")
    .toUpperCase();
}

interface Bucket {
  count: number;
  rSum: number;
  gSum: number;
  bSum: number;
}

/**
 * Extract the most prominent colors from a raster image.
 *
 * The image is downscaled, decoded to raw RGBA, and each opaque pixel is binned
 * into a coarse color bucket; buckets are ranked by pixel count and the average
 * color of each top bucket is returned. Pure with respect to its input buffer —
 * the only dependency is sharp for decoding — which makes it straightforward to
 * unit test and to call from an ingestion or capture handler.
 *
 * @param image Encoded image bytes (PNG/JPEG/WebP/etc.).
 * @returns Dominant colors ordered most→least prominent (empty if no opaque pixels).
 */
export async function extractDominantColors(
  image: Buffer,
  options?: ExtractDominantColorsOptions
): Promise<DominantColor[]> {
  const maxColors = Math.max(1, options?.maxColors ?? DEFAULTS.maxColors);
  const sampleSize = Math.max(1, options?.sampleSize ?? DEFAULTS.sampleSize);
  const quantizeBits = Math.max(1, Math.min(8, options?.quantizeBits ?? DEFAULTS.quantizeBits));
  const ignoreAlphaBelow = options?.ignoreAlphaBelow ?? DEFAULTS.ignoreAlphaBelow;
  const shift = 8 - quantizeBits;

  const { data, info } = await sharp(image)
    .resize(sampleSize, sampleSize, { fit: "inside", withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const channels = info.channels; // 4 after ensureAlpha
  const buckets = new Map<number, Bucket>();
  let opaquePixels = 0;

  for (let i = 0; i + channels - 1 < data.length; i += channels) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = channels >= 4 ? data[i + 3] : 255;
    if (a < ignoreAlphaBelow) {
      continue;
    }

    // Bucket key packs the high bits of each channel into one integer.
    const key = ((r >> shift) << 16) | ((g >> shift) << 8) | (b >> shift);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.count += 1;
      bucket.rSum += r;
      bucket.gSum += g;
      bucket.bSum += b;
    } else {
      buckets.set(key, { count: 1, rSum: r, gSum: g, bSum: b });
    }
    opaquePixels += 1;
  }

  if (opaquePixels === 0) {
    return [];
  }

  return Array.from(buckets.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, maxColors)
    .map((bucket) => ({
      hex: `#${toHex(bucket.rSum / bucket.count)}${toHex(bucket.gSum / bucket.count)}${toHex(
        bucket.bSum / bucket.count
      )}`,
      fraction: bucket.count / opaquePixels,
    }));
}
