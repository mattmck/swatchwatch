import { readBlobFromStorageUrl } from "./blob-storage";
import { decodeImageProxyId } from "./image-proxy";

/**
 * Re-read the image a hex detection call was shown, from the same `imageUrlOrDataUri`
 * that was sent to Azure OpenAI, so post-processing (`snapDetectionToImage`) measures
 * the pixels the model looked at:
 *
 *  - a `data:` URI is decoded in place (admin `recalc-hex`, local runs without storage);
 *  - a Functions image-proxy URL (`/api/images/{id}`, what ingestion sends when storage
 *    is configured) is decoded with the proxy's own signing key and the blob is read
 *    directly, skipping the HTTP hop through our own API;
 *  - any other http(s) URL (raw vendor image when storage is not configured) is fetched.
 *
 * Throws on failure; the snap step catches and keeps the raw hex.
 */

export const DETECTION_IMAGE_FETCH_TIMEOUT_MS = 20000;
/** Hard cap on fetched bytes; product photos are far smaller and a palette only needs 96px. */
export const DETECTION_IMAGE_MAX_BYTES = 25 * 1024 * 1024;

const IMAGE_PROXY_PATH = /\/api\/images\/([^/?#]+)/;

export interface LoadDetectionImageDeps {
  fetchImpl?: typeof fetch;
  readBlob?: (storageUrl: string) => Promise<{ bytes: Buffer }>;
  nowMs?: number;
}

/** Bytes of a `data:<type>;base64,<payload>` URI, or null when `uri` is not one. */
export function decodeDataUri(uri: string): Buffer | null {
  const match = uri.match(/^data:([^;,]*)(;base64)?,(.*)$/s);
  if (!match) return null;
  const [, , base64Flag, payload] = match;
  return base64Flag ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload), "utf8");
}

/** The signed id inside a `/api/images/{id}` URL, or null for any other URL. */
export function imageProxyIdFromUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(parsed.protocol)) return null;
  const match = parsed.pathname.match(IMAGE_PROXY_PATH);
  return match ? decodeURIComponent(match[1]) : null;
}

async function fetchImageBytes(url: string, fetchImpl: typeof fetch): Promise<Buffer> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DETECTION_IMAGE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, redirect: "follow" });
    if (!response.ok) {
      throw new Error(`Image fetch failed: ${response.status} ${response.statusText}`.trim());
    }
    const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
    if (Number.isFinite(declared) && declared > DETECTION_IMAGE_MAX_BYTES) {
      throw new Error(`Image too large: ${declared} bytes`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0) throw new Error("Image fetch returned an empty body");
    if (bytes.length > DETECTION_IMAGE_MAX_BYTES) throw new Error(`Image too large: ${bytes.length} bytes`);
    return bytes;
  } finally {
    clearTimeout(timeout);
  }
}

/** Bytes of the image behind `imageUrlOrDataUri` (see module docs). */
export async function loadDetectionImageBytes(
  imageUrlOrDataUri: string,
  deps: LoadDetectionImageDeps = {}
): Promise<Buffer> {
  const value = imageUrlOrDataUri.trim();
  if (!value) throw new Error("Image reference is empty");

  const inline = decodeDataUri(value);
  if (inline) {
    if (inline.length === 0) throw new Error("Data URI has no payload");
    return inline;
  }

  const proxyId = imageProxyIdFromUrl(value);
  if (proxyId) {
    const storageUrl = decodeImageProxyId(proxyId, deps.nowMs);
    const blob = await (deps.readBlob ?? readBlobFromStorageUrl)(storageUrl);
    if (!blob.bytes?.length) throw new Error("Blob read returned no bytes");
    return blob.bytes;
  }

  if (!/^https?:\/\//i.test(value)) {
    throw new Error("Unsupported image reference (expected a data URI or http(s) URL)");
  }
  return fetchImageBytes(value, deps.fetchImpl ?? fetch);
}
