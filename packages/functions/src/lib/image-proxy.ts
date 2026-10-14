import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Signed capability URLs for the `/api/images/{id}` proxy.
 *
 * Proxied images are rendered directly in `<img src>` tags, so the browser cannot attach an
 * Authorization header. Instead, the server hands out ids it has signed:
 *
 *   id = base64url(storageUrl) + "." + base64url(HMAC-SHA256(IMAGE_PROXY_SIGNING_KEY, context + storageUrl))
 *
 * Only URLs the API itself chose to expose can be fetched; forging an id for any other blob
 * (another user's media, raw connector payloads, ...) requires the signing key.
 *
 * Key resolution (fail closed):
 * - `IMAGE_PROXY_SIGNING_KEY` set (>= 32 chars) → used for signing and verification.
 * - `IMAGE_PROXY_SIGNING_KEY` set but too short → `ImageProxyConfigError` (misconfiguration).
 * - Unset and `AUTH_DEV_BYPASS === "true"` → a random per-process key is generated once and a
 *   warning is logged. Ids stay valid until the process restarts. Local development only.
 * - Unset otherwise → `ImageProxyConfigError`; nothing is signed or served.
 */

const IMAGE_PROXY_ROUTE_PREFIX = "/api/images/";
const SIGNATURE_CONTEXT = "swatchwatch:image-proxy:v1:";
const SIGNATURE_BYTES = 32;
export const MIN_IMAGE_PROXY_SIGNING_KEY_LENGTH = 32;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/** The proxy id is malformed, unsigned, or its signature does not verify. Map to 403. */
export class ImageProxyTokenError extends Error {
  constructor(message = "Invalid image proxy token") {
    super(message);
    this.name = "ImageProxyTokenError";
  }
}

/** The signing key is missing or unusable. Map to a generic 5xx; never serve unsigned. */
export class ImageProxyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageProxyConfigError";
  }
}

let devFallbackKey: Buffer | null = null;

function getSigningKey(): Buffer {
  const configured = process.env.IMAGE_PROXY_SIGNING_KEY?.trim();
  if (configured) {
    if (configured.length < MIN_IMAGE_PROXY_SIGNING_KEY_LENGTH) {
      throw new ImageProxyConfigError(
        `IMAGE_PROXY_SIGNING_KEY must be at least ${MIN_IMAGE_PROXY_SIGNING_KEY_LENGTH} characters`
      );
    }
    return Buffer.from(configured, "utf8");
  }

  if (process.env.AUTH_DEV_BYPASS === "true") {
    if (!devFallbackKey) {
      devFallbackKey = randomBytes(SIGNATURE_BYTES);
      console.warn(
        "[image-proxy] IMAGE_PROXY_SIGNING_KEY is not set; using an ephemeral per-process signing key " +
          "because AUTH_DEV_BYPASS=true. Image URLs will stop working after a restart. " +
          "Never run without IMAGE_PROXY_SIGNING_KEY outside local development."
      );
    }
    return devFallbackKey;
  }

  throw new ImageProxyConfigError("IMAGE_PROXY_SIGNING_KEY is not configured");
}

/** Test hook: forget the ephemeral dev key so the next call regenerates it. */
export function resetImageProxySigningStateForTests(): void {
  devFallbackKey = null;
}

function toBase64Url(input: Buffer | string): string {
  const buffer = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(input: string): Buffer {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padding = (4 - (normalized.length % 4)) % 4;
  return Buffer.from(normalized + "=".repeat(padding), "base64");
}

function sign(sourceImageUrl: string, key: Buffer): Buffer {
  return createHmac("sha256", key).update(SIGNATURE_CONTEXT + sourceImageUrl, "utf8").digest();
}

function normalizeHttpUrl(value: string): string {
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Invalid proxied image URL protocol");
  }
  return parsed.toString();
}

export function encodeImageProxyId(sourceImageUrl: string): string {
  const normalized = normalizeHttpUrl(sourceImageUrl);
  const key = getSigningKey();
  return `${toBase64Url(normalized)}.${toBase64Url(sign(normalized, key))}`;
}

export function toImageProxyUrlFromOrigin(origin: string, sourceImageUrl: string): string {
  const parsedOrigin = new URL(origin);
  if (!["http:", "https:"].includes(parsedOrigin.protocol)) {
    throw new Error("Invalid image proxy origin protocol");
  }
  const normalizedOrigin = `${parsedOrigin.protocol}//${parsedOrigin.host}`;
  return `${normalizedOrigin}${IMAGE_PROXY_ROUTE_PREFIX}${encodeImageProxyId(sourceImageUrl)}`;
}

export function toImageProxyUrl(requestUrl: string, sourceImageUrl: string): string {
  const origin = new URL(requestUrl).origin;
  return toImageProxyUrlFromOrigin(origin, sourceImageUrl);
}

/**
 * Verify a signed proxy id and return the storage URL it grants access to.
 *
 * @throws ImageProxyTokenError when the id is malformed, unsigned (legacy format), or forged.
 * @throws ImageProxyConfigError when no signing key is available.
 */
export function decodeImageProxyId(id: string): string {
  const key = getSigningKey();

  const parts = typeof id === "string" ? id.split(".") : [];
  if (parts.length !== 2) {
    throw new ImageProxyTokenError();
  }
  const [encodedUrl, encodedSignature] = parts;
  if (!BASE64URL_PATTERN.test(encodedUrl) || !BASE64URL_PATTERN.test(encodedSignature)) {
    throw new ImageProxyTokenError();
  }

  const providedSignature = fromBase64Url(encodedSignature);
  if (providedSignature.length !== SIGNATURE_BYTES) {
    throw new ImageProxyTokenError();
  }

  const decodedUrl = fromBase64Url(encodedUrl).toString("utf8");
  const expectedSignature = sign(decodedUrl, key);
  if (!timingSafeEqual(providedSignature, expectedSignature)) {
    throw new ImageProxyTokenError();
  }

  try {
    return normalizeHttpUrl(decodedUrl);
  } catch {
    throw new ImageProxyTokenError();
  }
}
