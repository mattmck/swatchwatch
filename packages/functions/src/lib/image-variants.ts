import {
  IMAGE_VARIANT_QUALITY,
  IMAGE_VARIANT_SIZES,
  type ImageVariantSize,
  snapImageVariantSize,
} from "swatchwatch-shared";

/**
 * Pre-generated catalog thumbnails (see `IMAGE_VARIANT_SIZES` in swatchwatch-shared).
 *
 * Each catalog blob `<name>` in `SOURCE_IMAGE_CONTAINER` gets sibling blobs
 * `<name>.c<IMAGE_VARIANT_CROP_VERSION>.w<size>.webp`: a square WebP at `IMAGE_VARIANT_QUALITY`,
 * cropped around the product (`planImageVariantCrop`). The image proxy renders a missing variant
 * with the same `renderImageVariant`, so a variant hit and a fallback miss return the same pixels.
 */

export { IMAGE_VARIANT_SIZES, IMAGE_VARIANT_QUALITY, type ImageVariantSize };

/**
 * Version of the crop rule baked into variant blob names. Bump it whenever `planImageVariantCrop`
 * or `renderImageVariant` changes the output: old variants are then simply not found (the proxy
 * resizes on the fly) until the backfill writes the new names. Existing blobs are never rewritten.
 */
export const IMAGE_VARIANT_CROP_VERSION = 1;

const VARIANT_SUFFIX = /(\.c\d+)?\.w\d+\.webp$/i;

/** Blob name of the `size` variant of the catalog blob `blobName`. */
export function imageVariantBlobName(blobName: string, size: ImageVariantSize): string {
  return `${blobName}${variantSuffix(size)}`;
}

function variantSuffix(size: ImageVariantSize): string {
  return `.c${IMAGE_VARIANT_CROP_VERSION}.w${size}.webp`;
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
  parsed.pathname = `${parsed.pathname}${variantSuffix(size)}`;
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

/** Long edge of the downscaled copy used to find the product (cheap, and enough for a bbox). */
const CROP_DETECTION_EDGE_PX = 512;
/** Max difference from the corner color that still counts as background (sharp `trim`). */
const CROP_TRIM_THRESHOLD = 24;
/** Only crop to the product when trimming the background removes more than 10% of the image. */
const CROP_MAX_KEPT_SHARE = 0.9;
/**
 * The square's side is at least this share of the product's long edge, so a tall bottle keeps
 * its body and label rather than shrinking to a sliver (or zooming into a featureless middle).
 */
const CROP_MIN_LONG_EDGE_SHARE = 0.65;
/** Breathing room around the product. */
const CROP_MARGIN = 1.08;

export interface ImageVariantCrop {
  left: number;
  top: number;
  width: number;
  height: number;
  /** Background (top-left pixel) used to pad the crop to a square when it exceeds the image. */
  background: { r: number; g: number; b: number; alpha: number };
}

/**
 * Where to crop a thumbnail so it frames the product: studio shots on a flat background (bottles,
 * swatch dots, product sets) are trimmed to the product's bounding box, then a square around its
 * center is taken (`CROP_MIN_LONG_EDGE_SHARE`, `CROP_MARGIN`), slid inside the image and padded
 * with the background color only when it is larger than the image. Returns null (plain center
 * crop) for photos without a flat background (on-nail swatches, lifestyle shots), when trimming
 * removes little, or when the image cannot be analysed. Deterministic for the same bytes.
 */
export async function planImageVariantCrop(bytes: Buffer): Promise<ImageVariantCrop | null> {
  try {
    const sharp = (await import("sharp")).default;
    const image = sharp(bytes, { failOn: "none" }).rotate();
    const meta = await image.metadata();
    const swap = (meta.orientation ?? 1) >= 5;
    const width = (swap ? meta.height : meta.width) ?? 0;
    const height = (swap ? meta.width : meta.height) ?? 0;
    if (width <= 0 || height <= 0) return null;

    const scale = Math.min(1, CROP_DETECTION_EDGE_PX / Math.max(width, height));
    const small = await sharp(bytes, { failOn: "none" })
      .rotate()
      .resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), fit: "fill" })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const background = {
      r: small.data[0],
      g: small.data[1],
      b: small.data[2],
      alpha: small.data[3] / 255,
    };
    const trimmed = await sharp(small.data, {
      raw: { width: small.info.width, height: small.info.height, channels: small.info.channels },
    })
      .trim({ threshold: CROP_TRIM_THRESHOLD })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const info = trimmed.info as typeof trimmed.info & { trimOffsetLeft?: number; trimOffsetTop?: number };
    const kept = (info.width * info.height) / (small.info.width * small.info.height);
    if (kept > CROP_MAX_KEPT_SHARE) return null;

    // Back to full-resolution coordinates.
    const productWidth = info.width / scale;
    const productHeight = info.height / scale;
    const centerX = -(info.trimOffsetLeft ?? 0) / scale + productWidth / 2;
    const centerY = -(info.trimOffsetTop ?? 0) / scale + productHeight / 2;
    const side =
      Math.max(
        Math.min(productWidth, productHeight),
        CROP_MIN_LONG_EDGE_SHARE * Math.max(productWidth, productHeight)
      ) * CROP_MARGIN;

    const cropWidth = Math.max(1, Math.min(width, Math.round(side)));
    const cropHeight = Math.max(1, Math.min(height, Math.round(side)));
    const left = Math.min(Math.max(0, Math.round(centerX - cropWidth / 2)), width - cropWidth);
    const top = Math.min(Math.max(0, Math.round(centerY - cropHeight / 2)), height - cropHeight);
    return { left, top, width: cropWidth, height: cropHeight, background };
  } catch {
    // Uniform images make trim throw; anything unanalysable just gets the center crop.
    return null;
  }
}

/**
 * Render one square WebP variant. With a crop (`planImageVariantCrop`, computed here when not
 * passed) the product region is cut out and fitted into the square, padded with the background
 * color when the region is not square; without one the image is center-cropped (`fit: "cover"`).
 * `withoutEnlargement` keeps small originals at their own size. Pass a precomputed `crop` when
 * rendering several sizes of one image; it must come from the same bytes.
 */
export async function renderImageVariant(
  bytes: Buffer,
  size: ImageVariantSize,
  crop?: ImageVariantCrop | null
): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const plan = crop === undefined ? await planImageVariantCrop(bytes) : crop;
  const pipeline = sharp(bytes, { failOn: "none" }).rotate();
  if (plan) {
    pipeline
      .extract({ left: plan.left, top: plan.top, width: plan.width, height: plan.height })
      .resize({ width: size, height: size, fit: "contain", background: plan.background, withoutEnlargement: true });
  } else {
    pipeline.resize({ width: size, height: size, fit: "cover", withoutEnlargement: true });
  }
  return pipeline.webp({ quality: IMAGE_VARIANT_QUALITY }).toBuffer();
}
