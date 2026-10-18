import { IMAGE_VARIANT_SIZES, snapImageVariantSize } from "swatchwatch-shared";

const LARGEST_VARIANT = IMAGE_VARIANT_SIZES[IMAGE_VARIANT_SIZES.length - 1];

function isProxyImagePath(pathname: string): boolean {
  return pathname.startsWith("/api/images/");
}

/** Pixel size of the pre-generated thumbnail that covers `size` (capped at the largest one). */
function thumbnailPixels(size: number): number {
  return snapImageVariantSize(Math.max(1, Math.floor(size))) ?? LARGEST_VARIANT;
}

/**
 * Build a square thumbnail URL for proxied swatch images.
 *
 * `size` (pixels) is snapped up to the pre-generated variant ladder (`IMAGE_VARIANT_SIZES`:
 * 64/128/256/512), so the API serves a stored thumbnail instead of resizing the original.
 * Only transforms `/api/images/:id` URLs so external image URLs are left untouched.
 */
export function buildSwatchThumbnailUrl(
  url: string,
  size: number = 96
): string {
  const pixels = thumbnailPixels(size);
  const query = `w=${pixels}&h=${pixels}&fit=cover&fm=webp&q=72`;

  try {
    const parsed = new URL(url);
    if (!isProxyImagePath(parsed.pathname)) {
      return url;
    }

    parsed.searchParams.set("w", String(pixels));
    parsed.searchParams.set("h", String(pixels));
    parsed.searchParams.set("fit", "cover");
    parsed.searchParams.set("fm", "webp");
    parsed.searchParams.set("q", "72");
    return parsed.toString();
  } catch {
    if (!isProxyImagePath(url)) {
      return url;
    }
    return `${url}${url.includes("?") ? "&" : "?"}${query}`;
  }
}

export interface SwatchThumbnailSources {
  src: string;
  /** `1x`/`2x` density candidates; absent for non-proxy URLs or when both densities match. */
  srcSet?: string;
  width: number;
  height: number;
}

/**
 * `<img>` sources for a square swatch thumbnail displayed at `displaySize` CSS pixels: the 1x
 * variant as `src`, plus a `srcSet` whose `2x` candidate serves high-density screens. External
 * URLs pass through unchanged (no srcSet). `width`/`height` are the display size, so the browser
 * reserves the box before the image loads.
 */
export function buildSwatchThumbnailSources(url: string, displaySize: number): SwatchThumbnailSources {
  const display = Math.max(1, Math.round(displaySize));
  const src = buildSwatchThumbnailUrl(url, display);
  if (src === url) {
    return { src, width: display, height: display };
  }
  const retina = buildSwatchThumbnailUrl(url, display * 2);
  return {
    src,
    srcSet: retina === src ? undefined : `${src} 1x, ${retina} 2x`,
    width: display,
    height: display,
  };
}
