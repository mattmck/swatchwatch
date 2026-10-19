import type { ImgHTMLAttributes } from "react";
import { buildSwatchThumbnailSources } from "@/lib/image-url";

type SwatchThumbnailProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "srcSet" | "width" | "height"> & {
  /** Proxied (`/api/images/...`) or external image URL. */
  src: string;
  /** Rendered size in CSS pixels; picks the pre-generated 1x/2x thumbnails. */
  displaySize: number;
  alt: string;
};

/**
 * Square catalog-image thumbnail: a plain lazy `<img>` with a 1x/2x `srcSet` of the image proxy's
 * pre-generated variants (`buildSwatchThumbnailSources`). Plain `<img>` because the static export
 * has no image optimizer and `next/image` does not accept a custom `srcSet`.
 */
export function SwatchThumbnail({ src, displaySize, alt, loading = "lazy", decoding = "async", ...rest }: SwatchThumbnailProps) {
  const sources = buildSwatchThumbnailSources(src, displaySize);
  return (
    // eslint-disable-next-line @next/next/no-img-element -- proxied thumbnails, no optimizer in static export
    <img
      {...rest}
      src={sources.src}
      srcSet={sources.srcSet}
      width={sources.width}
      height={sources.height}
      alt={alt}
      loading={loading}
      decoding={decoding}
    />
  );
}
