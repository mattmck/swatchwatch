import { isCatalogStorageUrl } from "./blob-storage";
import { toImageProxyUrl } from "./image-proxy";

/**
 * A public (v2) proxy URL for a catalog-container blob, or null. Anything else (user media,
 * other containers, external URLs) is omitted: never a private v3 id, never a raw storage URL.
 * Used by the anonymous share pages (wishlist #268, looks).
 */
export function publicCatalogImageUrl(storageUrl: string | null | undefined, requestUrl: string): string | null {
  const url = storageUrl?.trim();
  if (!url) return null;
  try {
    if (!isCatalogStorageUrl(url)) return null;
    const proxied = toImageProxyUrl(requestUrl, url);
    return new URL(proxied).pathname.startsWith("/api/images/v2.") ? proxied : null;
  } catch {
    return null;
  }
}
