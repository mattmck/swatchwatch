import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isDevBypassEnabled } from "./runtime-env";
import { trackEvent } from "./telemetry";

/**
 * Signed, expiring capability URLs for the `/api/images/{id}` proxy.
 *
 * Proxied images are rendered directly in `<img src>` tags, so the browser cannot attach an
 * Authorization header. Instead, the server hands out ids it has signed:
 *
 *   id = "v2." + base64url(storageUrl) + "." + base36(expiresAtUnixSeconds) + "." + base64url(sig)
 *   sig = HMAC-SHA256(IMAGE_PROXY_SIGNING_KEY, "swatchwatch:image-proxy:v2:" + exp + ":" + storageUrl)
 *
 * The expiry is covered by the HMAC, so it cannot be extended without the key. Only URLs the API
 * itself chose to expose can be fetched; forging an id for any other blob (another user's media,
 * raw connector payloads, ...) requires the signing key.
 *
 * Expiry and bucketing: `IMAGE_PROXY_ID_TTL_SECONDS` (default 3 days, clamped to 1h..30d) is the
 * guaranteed minimum remaining lifetime of a freshly minted id. To keep ids stable (and so
 * HTTP/browser-cacheable) the expiry is bucketed:
 *
 *   bucket = min(ttl, 1 day);  exp = (floor(now / bucket) + 1) * bucket + ttl
 *
 * so every mint within the same bucket yields the identical id, and the remaining lifetime at mint
 * time is in [ttl, ttl + bucket]. The default must comfortably exceed the Azure OpenAI batch
 * completion window (up to 24h), because ingestion hands these URLs to the vision batch pipeline.
 *
 * Legacy v1 ids (`base64url(url).base64url(sig)`, no expiry) are never minted any more. They are
 * accepted only while `IMAGE_PROXY_LEGACY_ID_ACCEPT_UNTIL` (ISO-8601) is set and in the future, so
 * previously issued URLs can drain; each accepted legacy id emits `image_proxy.legacy_id_accepted`.
 *
 * Key resolution (fail closed):
 * - `IMAGE_PROXY_SIGNING_KEY` set (>= 32 chars) → used for signing and verification.
 * - `IMAGE_PROXY_SIGNING_KEY` set but too short → `ImageProxyConfigError` (misconfiguration).
 * - Unset and dev bypass enabled (`AUTH_DEV_BYPASS=true` and NOT hosted in Azure, see
 *   `isDevBypassEnabled`) → a random per-process key is generated once and a warning is logged.
 *   Ids stay valid until the process restarts. Local development only.
 * - Unset otherwise → `ImageProxyConfigError`; nothing is signed or served.
 */

const IMAGE_PROXY_ROUTE_PREFIX = "/api/images/";
const LEGACY_SIGNATURE_CONTEXT = "swatchwatch:image-proxy:v1:";
const SIGNATURE_CONTEXT = "swatchwatch:image-proxy:v2:";
const ID_VERSION_PREFIX = "v2";
const DEFAULT_ID_TTL_SECONDS = 3 * 24 * 60 * 60;
const MIN_ID_TTL_SECONDS = 60 * 60;
const MAX_ID_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_BUCKET_SECONDS = 24 * 60 * 60;
/** Tolerated clock difference between the minting and verifying instance. */
const CLOCK_SKEW_SECONDS = 60;
const BASE36_PATTERN = /^[0-9a-z]{1,12}$/;
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

  if (isDevBypassEnabled()) {
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

function signLegacy(sourceImageUrl: string, key: Buffer): Buffer {
  return createHmac("sha256", key)
    .update(LEGACY_SIGNATURE_CONTEXT + sourceImageUrl, "utf8")
    .digest();
}

function sign(sourceImageUrl: string, expiresAt: number, key: Buffer): Buffer {
  return createHmac("sha256", key)
    .update(`${SIGNATURE_CONTEXT}${expiresAt}:${sourceImageUrl}`, "utf8")
    .digest();
}

/** TTL guaranteed to remain on a freshly minted id, from `IMAGE_PROXY_ID_TTL_SECONDS`. */
function getIdTtlSeconds(): number {
  const raw = process.env.IMAGE_PROXY_ID_TTL_SECONDS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  const ttl = Number.isFinite(parsed) ? parsed : DEFAULT_ID_TTL_SECONDS;
  return Math.min(MAX_ID_TTL_SECONDS, Math.max(MIN_ID_TTL_SECONDS, ttl));
}

/** Bucketed expiry (unix seconds); remaining lifetime at `nowMs` is within [ttl, ttl + bucket]. */
function computeExpiry(nowMs: number): number {
  const ttl = getIdTtlSeconds();
  const bucket = Math.min(ttl, MAX_BUCKET_SECONDS);
  const nowSeconds = Math.floor(nowMs / 1000);
  return (Math.floor(nowSeconds / bucket) + 1) * bucket + ttl;
}

function normalizeHttpUrl(value: string): string {
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Invalid proxied image URL protocol");
  }
  return parsed.toString();
}

export function encodeImageProxyId(sourceImageUrl: string, nowMs: number = Date.now()): string {
  const normalized = normalizeHttpUrl(sourceImageUrl);
  const key = getSigningKey();
  const expiresAt = computeExpiry(nowMs);
  return [
    ID_VERSION_PREFIX,
    toBase64Url(normalized),
    expiresAt.toString(36),
    toBase64Url(sign(normalized, expiresAt, key)),
  ].join(".");
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

export interface DecodedImageProxyId {
  /** Storage URL the id grants access to. */
  url: string;
  /**
   * Unix seconds after which the id stops working. For legacy v1 ids this is the end of the
   * legacy grace window (so callers can cap cache lifetimes on it).
   */
  expiresAt: number;
}

function parseLegacyAcceptUntilSeconds(): number | null {
  const raw = process.env.IMAGE_PROXY_LEGACY_ID_ACCEPT_UNTIL?.trim();
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function readSignature(encoded: string): Buffer {
  if (!BASE64URL_PATTERN.test(encoded)) {
    throw new ImageProxyTokenError();
  }
  const signature = fromBase64Url(encoded);
  if (signature.length !== SIGNATURE_BYTES) {
    throw new ImageProxyTokenError();
  }
  // Base64 decoding ignores the trailing padding bits, so several strings decode to the same
  // bytes. Accept only the canonical encoding so a signature has exactly one valid spelling.
  if (toBase64Url(signature) !== encoded) {
    throw new ImageProxyTokenError();
  }
  return signature;
}

function readUrl(encoded: string): string {
  if (!BASE64URL_PATTERN.test(encoded)) {
    throw new ImageProxyTokenError();
  }
  return fromBase64Url(encoded).toString("utf8");
}

function finishDecode(decodedUrl: string, expiresAt: number): DecodedImageProxyId {
  try {
    return { url: normalizeHttpUrl(decodedUrl), expiresAt };
  } catch {
    throw new ImageProxyTokenError();
  }
}

/**
 * Verify a signed proxy id and return the storage URL it grants access to plus its expiry.
 *
 * @throws ImageProxyTokenError when the id is malformed, forged, expired, or a legacy v1 id
 *   outside the `IMAGE_PROXY_LEGACY_ID_ACCEPT_UNTIL` grace window.
 * @throws ImageProxyConfigError when no signing key is available.
 */
export function decodeImageProxyIdWithExpiry(
  id: string,
  nowMs: number = Date.now()
): DecodedImageProxyId {
  const key = getSigningKey();
  const nowSeconds = Math.floor(nowMs / 1000);

  const parts = typeof id === "string" ? id.split(".") : [];

  if (parts.length === 4 && parts[0] === ID_VERSION_PREFIX) {
    const [, encodedUrl, encodedExpiry, encodedSignature] = parts;
    if (!BASE36_PATTERN.test(encodedExpiry)) {
      throw new ImageProxyTokenError();
    }
    const providedSignature = readSignature(encodedSignature);
    const decodedUrl = readUrl(encodedUrl);
    const expiresAt = Number.parseInt(encodedExpiry, 36);

    // Verify the signature (which covers the expiry) before trusting the expiry value.
    if (!timingSafeEqual(providedSignature, sign(decodedUrl, expiresAt, key))) {
      throw new ImageProxyTokenError();
    }
    if (nowSeconds > expiresAt + CLOCK_SKEW_SECONDS) {
      throw new ImageProxyTokenError("Image proxy token expired");
    }
    return finishDecode(decodedUrl, expiresAt);
  }

  if (parts.length === 2) {
    const [encodedUrl, encodedSignature] = parts;
    const providedSignature = readSignature(encodedSignature);
    const decodedUrl = readUrl(encodedUrl);

    if (!timingSafeEqual(providedSignature, signLegacy(decodedUrl, key))) {
      throw new ImageProxyTokenError();
    }
    const acceptUntil = parseLegacyAcceptUntilSeconds();
    if (acceptUntil === null || nowSeconds > acceptUntil) {
      throw new ImageProxyTokenError("Legacy image proxy token no longer accepted");
    }
    trackEvent("image_proxy.legacy_id_accepted");
    return finishDecode(decodedUrl, acceptUntil);
  }

  throw new ImageProxyTokenError();
}

/** Verify a signed proxy id and return the storage URL it grants access to. */
export function decodeImageProxyId(id: string, nowMs: number = Date.now()): string {
  return decodeImageProxyIdWithExpiry(id, nowMs).url;
}
