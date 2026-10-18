import {
  IMAGE_VARIANT_QUALITY,
  IMAGE_VARIANT_SIZES,
  type ImageVariantSize,
  snapImageVariantSize,
} from "swatchwatch-shared";

/**
 * Pre-generated catalog thumbnails (see `IMAGE_VARIANT_SIZES` in swatchwatch-shared).
 *
 * Each catalog blob `<name>` in `SOURCE_IMAGE_CONTAINER` gets sibling blobs `<name>.w<size>.webp`:
 * square, center-cropped (`fit: "cover"`, never enlarged) WebP at `IMAGE_VARIANT_QUALITY`. The
 * image proxy renders on-the-fly transforms with the same `renderImageVariant` pipeline, so a
 * variant hit and a fallback miss return the same pixels.
 */

export { IMAGE_VARIANT_SIZES, IMAGE_VARIANT_QUALITY, type ImageVariantSize };

const VARIANT_SUFFIX = /\.w\d+\.webp$/i;

/** Blob name of the `size` variant of the catalog blob `blobName`. */
export function imageVariantBlobName(blobName: string, size: ImageVariantSize): string {
  return `${blobName}.w${size}.webp`;
}

/** True for a variant blob name (so a backfill never makes variants of variants). */
export function isImageVariantBlobName(blobName: string): boolean {
  return VARIANT_SUFFIX.test(blobName);
}

/**
 * Storage URL of the `size` variant of the blob at `storageUrl`: same account, container and
 * path, plus the variant suffix. Returns null for URLs that cannot carry a variant (unparseable,
 * with a query string or fragment, or already a variant).
 */
export function imageVariantStorageUrl(storageUrl: string, size: ImageVariantSize): string | null {
  let parsed: URL;
  try {
    parsed = new URL(storageUrl);
  } catch {
    return null;
  }
  if (parsed.search || parsed.hash || parsed.pathname.endsWith("/") || isImageVariantBlobName(parsed.pathname)) {
    return null;
  }
  parsed.pathname = `${parsed.pathname}.w${size}.webp`;
  return parsed.toString();
}

export interface VariantTransformRequest {
  width?: number;
  height?: number;
  fit: string;
  format?: string;
  quality: number;
}

/**
 * The variant size that serves a proxy transform request, or null when the request is not a
 * square cover WebP at the variant quality (those keep resizing on the fly). The requested size is
 * snapped up to the next ladder size, so `?w=96&h=96` is served by the 128px variant; a request
 * above the largest size is not snapped.
 */
export function matchImageVariantSize(transform: VariantTransformRequest): ImageVariantSize | null {
  if (transform.fit !== "cover" || transform.format !== "webp") return null;
  if (transform.quality !== IMAGE_VARIANT_QUALITY) return null;
  if (!transform.width || transform.width !== transform.height) return null;
  return snapImageVariantSize(transform.width);
}

/**
 * Render one square cover WebP variant. `withoutEnlargement` keeps small originals at their own
 * size (as the on-the-fly transform always has).
 */
export async function renderImageVariant(bytes: Buffer, size: ImageVariantSize): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  return sharp(bytes, { failOn: "none" })
    .rotate()
    .resize({ width: size, height: size, fit: "cover", withoutEnlargement: true })
    .webp({ quality: IMAGE_VARIANT_QUALITY })
    .toBuffer();
}
