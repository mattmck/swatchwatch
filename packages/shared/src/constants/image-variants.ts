/**
 * Pre-generated catalog image thumbnails ("variants"). Ingestion writes one square, center-cropped
 * (`fit=cover`) WebP per size next to each catalog blob, and the image proxy serves
 * `?w=<n>&h=<n>&fit=cover&fm=webp` requests from them instead of resizing the original per request.
 *
 * The sizes cover what the web actually renders, at 1x and 2x density: 40–64px list/strip
 * thumbnails (64 / 128), the 80px review-queue swatch (128 / 256) and the detail-page image grid
 * (256 / 512). Changing the ladder needs a backfill (`POST /api/images-admin/variants/backfill`)
 * so existing images get the new sizes; until then the proxy falls back to on-the-fly resizing.
 */
export const IMAGE_VARIANT_SIZES = [64, 128, 256, 512] as const;

export type ImageVariantSize = (typeof IMAGE_VARIANT_SIZES)[number];

/** WebP quality of every variant; also the proxy's default `q`, so plain variant URLs omit it. */
export const IMAGE_VARIANT_QUALITY = 72;

/**
 * Smallest variant size that is at least `size` CSS/device pixels, or null when `size` is larger
 * than the biggest variant (callers then resize on the fly or use the original).
 */
export function snapImageVariantSize(size: number): ImageVariantSize | null {
  if (!Number.isFinite(size)) return null;
  for (const candidate of IMAGE_VARIANT_SIZES) {
    if (candidate >= size) return candidate;
  }
  return null;
}
