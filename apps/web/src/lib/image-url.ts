/**
 * Build a lightweight thumbnail URL for proxied swatch images.
 *
 * Only transforms `/api/images/:id` URLs so external image URLs are left untouched.
 */
export function buildSwatchThumbnailUrl(
  url: string,
  size: number = 96
): string {
  const clampedSize = Math.min(256, Math.max(32, Math.floor(size)));
  const query = `w=${clampedSize}&h=${clampedSize}&fit=cover&fm=webp&q=72`;

  try {
    const parsed = new URL(url);
    if (!parsed.pathname.startsWith("/api/images/")) {
      return url;
    }

    parsed.searchParams.set("w", String(clampedSize));
    parsed.searchParams.set("h", String(clampedSize));
    parsed.searchParams.set("fit", "cover");
    parsed.searchParams.set("fm", "webp");
    parsed.searchParams.set("q", "72");
    return parsed.toString();
  } catch {
    if (!url.startsWith("/api/images/")) {
      return url;
    }
    return `${url}${url.includes("?") ? "&" : "?"}${query}`;
  }
}

