import { IMAGE_VARIANT_SIZES, snapImageVariantSize } from "swatchwatch-shared";
import { API_BASE_URL } from "@/config/env";

const LARGEST_VARIANT = IMAGE_VARIANT_SIZES[IMAGE_VARIANT_SIZES.length - 1];

/**
 * Square thumbnail URL for a catalog image, like the web's `buildSwatchThumbnailUrl`: proxied
 * `/api/images/{id}` URLs get `w/h/fit/fm` so the API serves a pre-generated WebP variant
 * (64/128/256/512, snapped up from `pixels`); other URLs pass through. Relative proxy paths
 * are resolved against the API origin.
 */
export function swatchThumbnailUrl(url: string, pixels: number): string {
  const size = snapImageVariantSize(Math.max(1, Math.floor(pixels))) ?? LARGEST_VARIANT;
  let absolute = url;
  if (url.startsWith("/")) {
    const origin = /^(https?:\/\/[^/]+)/.exec(API_BASE_URL)?.[1] ?? "";
    absolute = `${origin}${url}`;
  }
  const pathMatch = /^https?:\/\/[^/]+(\/[^?#]*)/.exec(absolute);
  if (!pathMatch || !pathMatch[1].startsWith("/api/images/")) return absolute;
  const params = `w=${size}&h=${size}&fit=cover&fm=webp&q=72`;
  const base = absolute.replace(/([?&])(w|h|fit|fm|q)=[^&#]*/g, "$1").replace(/[?&]+$/, "");
  return `${base}${base.includes("?") ? "&" : "?"}${params}`;
}
