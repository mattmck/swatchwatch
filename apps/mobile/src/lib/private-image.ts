/**
 * Pure helpers for private user media (#227, #270, #327) on mobile: owner-scoped `v3` image URLs
 * (`/api/images/v3.*`) are only ever fetched with the owner's bearer token, and the bytes are
 * kept in memory as data URIs (never on disk). No React, no fetch: unit-tested directly.
 * The fetch/auth half lives in `private-image-loader.ts`.
 */

const PRIVATE_IMAGE_PATH_PREFIX = "/api/images/v3.";

/** Origin (`scheme://host[:port]`) of an absolute http(s) URL, lowercased, or null. */
export function urlOrigin(url: string): string | null {
  const match = /^(https?:\/\/[^/?#]+)/i.exec(url);
  return match ? match[1].toLowerCase() : null;
}

function urlPath(url: string): string | null {
  if (url.startsWith("/")) return url.split(/[?#]/)[0] ?? null;
  const match = /^https?:\/\/[^/?#]+(\/[^?#]*)?/i.exec(url);
  return match ? (match[1] ?? "/") : null;
}

/**
 * Absolute URL for a private image id when it is safe to send the bearer token to it: the path
 * starts with `/api/images/v3.` and the URL is relative (resolved against the API origin) or
 * already on the API origin. Anything else (another host, `v2` ids, data URIs) returns null,
 * so the token never goes to a foreign host.
 */
export function resolvePrivateImageUrl(url: string | null | undefined, apiBaseUrl: string): string | null {
  if (typeof url !== "string" || url.length === 0) return null;
  const apiOrigin = urlOrigin(apiBaseUrl);
  if (!apiOrigin) return null;
  if (url.startsWith("//")) return null;
  const path = urlPath(url);
  if (!path || !path.startsWith(PRIVATE_IMAGE_PATH_PREFIX)) return null;
  if (url.startsWith("/")) return `${apiOrigin}${url}`;
  return urlOrigin(url) === apiOrigin ? url : null;
}

export type PrivateImageOutcome = "ready" | "denied" | "error";

/** HTTP status from the image route → load outcome (401/403 = not the owner or signed out). */
export function classifyPrivateImageStatus(status: number): PrivateImageOutcome {
  if (status >= 200 && status < 300) return "ready";
  if (status === 401 || status === 403) return "denied";
  return "error";
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Base64 of raw bytes (Hermes has no Buffer). */
export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    parts.push(
      BASE64_ALPHABET[(n >> 18) & 63] + BASE64_ALPHABET[(n >> 12) & 63] + BASE64_ALPHABET[(n >> 6) & 63] + BASE64_ALPHABET[n & 63],
    );
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    parts.push(`${BASE64_ALPHABET[(n >> 18) & 63]}${BASE64_ALPHABET[(n >> 12) & 63]}==`);
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    parts.push(`${BASE64_ALPHABET[(n >> 18) & 63]}${BASE64_ALPHABET[(n >> 12) & 63]}${BASE64_ALPHABET[(n >> 6) & 63]}=`);
  }
  return parts.join("");
}

/** Data URI for image bytes; a non-image content type is labeled JPEG (the server re-encodes to JPEG). */
export function imageDataUri(contentType: string | null | undefined, bytes: Uint8Array): string {
  const type = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  const safeType = /^image\/[a-z0-9.+-]+$/.test(type) ? type : "image/jpeg";
  return `data:${safeType};base64,${bytesToBase64(bytes)}`;
}

/**
 * Small in-memory LRU of decoded private images (data URIs), so scrolling back to a mani or
 * re-opening a polish doesn't refetch. Memory only; cleared on sign-out.
 */
export class MemoryImageCache {
  private entries = new Map<string, string>();

  constructor(private readonly maxEntries = 24) {}

  get(key: string): string | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: string, value: string): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
