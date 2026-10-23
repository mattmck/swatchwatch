import { createHash, createHmac } from "node:crypto";
import { describeFetchError, fetchWithRetry } from "./fetch-retry";
export { SourceImageUploadError, describeImageStoreFailure, type SourceImageUploadStep } from "./image-store-error";
import { computeImageFingerprintSafely, type ImageFingerprint } from "./gallery-dedupe";
import { ImageProxyConfigError } from "./image-proxy-errors";
import {
  IMAGE_VARIANT_SIZES,
  type ImageVariantSize,
  imageVariantBlobName,
  planImageVariantCrop,
  renderImageVariant,
} from "./image-variants";
import { blobStorageRetry, blobStorageTransport, getBlobStorageDispatcher } from "./storage-http";
import { SourceImageUploadError, type SourceImageUploadStep } from "./image-store-error";

const AZURE_STORAGE_API_VERSION = "2023-11-03";
const DEFAULT_SOURCE_IMAGE_CONTAINER = "source-images";
const DEFAULT_USER_MEDIA_CONTAINER = "nail-photos";
const REQUEST_TIMEOUT_MS = 20000;

export const UPLOAD_LIMITS = {
  maxSizeBytes: 5 * 1024 * 1024,
  allowedMimeTypes: new Set([
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/heic",
    "image/heif",
    "image/gif",
  ]),
} as const;

interface StorageAccountConfig {
  accountName: string;
  accountKey?: Buffer;
  sasToken?: string;
  blobEndpoint: string;
}

export interface UploadedBlobImage {
  storageUrl: string;
  checksumSha256: string;
  contentType: string;
  sizeBytes: number;
  imageBase64DataUri?: string | null;
  /**
   * Perceptual fingerprint of the stored (normalized) bytes, for `image_asset.perceptual_hash` etc.
   * (catalog gallery near-duplicate checks, see lib/gallery-dedupe). Null when it cannot be computed.
   */
  fingerprint?: ImageFingerprint | null;
}

interface UploadSourceImageOptions {
  sourceImageUrl: string;
  source: string;
  externalId: string;
  includeBase64DataUri?: boolean;
}

function normalizeImageContentType(contentType: string): string {
  return contentType.split(";")[0].trim().toLowerCase();
}

function assertAllowedImageType(contentType: string): string {
  const normalizedType = normalizeImageContentType(contentType || "");
  if (!normalizedType || !UPLOAD_LIMITS.allowedMimeTypes.has(normalizedType)) {
    throw new Error(
      `Unsupported image type: ${normalizedType || "unknown"}. Allowed: ${[...UPLOAD_LIMITS.allowedMimeTypes].join(", ")}`
    );
  }
  return normalizedType;
}

export function validateImageUpload(contentType: string, sizeBytes: number): string {
  const normalizedType = assertAllowedImageType(contentType);
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    throw new Error("Image payload is empty");
  }
  if (sizeBytes > UPLOAD_LIMITS.maxSizeBytes) {
    throw new Error(
      `Image too large: ${(sizeBytes / (1024 * 1024)).toFixed(1)}MB exceeds ${(UPLOAD_LIMITS.maxSizeBytes / (1024 * 1024)).toFixed(1)}MB limit`
    );
  }

  return normalizedType;
}

const DEFAULT_SOURCE_IMAGE_MAX_EDGE_PX = 2048;
const MIN_SOURCE_IMAGE_MAX_EDGE_PX = 256;
const MAX_SOURCE_IMAGE_MAX_EDGE_PX = 8192;
const DEFAULT_SOURCE_IMAGE_MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
const MAX_SOURCE_IMAGE_MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
/** Quality for the WebP fallback used when the format-preserving re-encode is still too big. */
const OVERSIZE_WEBP_QUALITY = 85;

export interface SourceImageLimits {
  /** Long edge (px) above which an ingested source image is downscaled before storage. */
  maxEdgePx: number;
  /** Largest source image download accepted; bigger ones are refused before decoding. */
  maxDownloadBytes: number;
}

function readClampedIntEnv(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

/**
 * `SOURCE_IMAGE_MAX_EDGE_PX` (default 2048, clamped 256–8192) and
 * `SOURCE_IMAGE_MAX_DOWNLOAD_BYTES` (default 25 MB, clamped 5–100 MB). 2048px covers every
 * consumer: Azure OpenAI vision downsamples to 2048px even at `detail: high` (512px at `low`),
 * and the image proxy's display transforms stop at 1024px.
 */
export function resolveSourceImageLimits(): SourceImageLimits {
  return {
    maxEdgePx: readClampedIntEnv(
      "SOURCE_IMAGE_MAX_EDGE_PX",
      DEFAULT_SOURCE_IMAGE_MAX_EDGE_PX,
      MIN_SOURCE_IMAGE_MAX_EDGE_PX,
      MAX_SOURCE_IMAGE_MAX_EDGE_PX
    ),
    maxDownloadBytes: readClampedIntEnv(
      "SOURCE_IMAGE_MAX_DOWNLOAD_BYTES",
      DEFAULT_SOURCE_IMAGE_MAX_DOWNLOAD_BYTES,
      UPLOAD_LIMITS.maxSizeBytes,
      MAX_SOURCE_IMAGE_MAX_DOWNLOAD_BYTES
    ),
  };
}

export interface NormalizedSourceImage {
  bytes: Buffer;
  contentType: string;
  /** True when the long edge was downscaled to `maxEdgePx`. */
  resized: boolean;
  /** True when the image was re-encoded as WebP to fit `maxStoredBytes`. */
  reencoded: boolean;
}

/**
 * Prepare a downloaded catalog image for storage: strip metadata (as `stripImageMetadata`),
 * downscale a long edge over `maxEdgePx`, and, if the format-preserving result is still over
 * `maxStoredBytes` (large PNGs), re-encode it as WebP. An image within both limits goes through
 * exactly the `stripImageMetadata` pipeline, so its checksum (and checksum-named blob) is
 * unchanged. Undecodable input is returned as-is for the caller's size check to judge.
 */
export async function normalizeSourceImage(
  bytes: Buffer,
  contentType: string,
  options: { maxEdgePx: number; maxStoredBytes?: number }
): Promise<NormalizedSourceImage> {
  const maxStoredBytes = options.maxStoredBytes ?? UPLOAD_LIMITS.maxSizeBytes;
  try {
    const sharpModule = await import("sharp");
    const sharp = sharpModule.default;
    const metadata = await sharp(bytes, { failOn: "none" }).metadata();
    const longEdge = Math.max(metadata.width ?? 0, metadata.height ?? 0);
    const resized = longEdge > options.maxEdgePx;
    const pipeline = () => {
      const image = sharp(bytes, { failOn: "none" }).rotate();
      return resized
        ? image.resize({
            width: options.maxEdgePx,
            height: options.maxEdgePx,
            fit: "inside",
            withoutEnlargement: true,
          })
        : image;
    };

    const output = await pipeline().toBuffer();
    if (output.length <= maxStoredBytes) {
      return { bytes: output, contentType, resized, reencoded: false };
    }
    const webp = await pipeline().webp({ quality: OVERSIZE_WEBP_QUALITY }).toBuffer();
    return { bytes: webp, contentType: "image/webp", resized, reencoded: true };
  } catch (error) {
    console.warn("[blob-storage] Failed to normalize source image, using original bytes:", error);
    return { bytes, contentType, resized: false, reencoded: false };
  }
}

function formatMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

function downloadTooLarge(sizeBytes: number | null, maxBytes: number): Error {
  const size = sizeBytes === null ? `more than ${formatMb(maxBytes)}MB` : `${formatMb(sizeBytes)}MB`;
  return new Error(`Image too large to download: ${size} exceeds ${formatMb(maxBytes)}MB download limit`);
}

/**
 * Read a fetch response body, never buffering more than `maxBytes`: a declared Content-Length
 * over the cap is refused without reading, and a streamed body is cancelled once it passes it.
 */
async function readResponseCapped(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw downloadTooLarge(declared, maxBytes);
  }
  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw downloadTooLarge(bytes.length, maxBytes);
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw downloadTooLarge(null, maxBytes);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

export async function stripImageMetadata(bytes: Buffer): Promise<Buffer> {
  try {
    const sharpModule = await import("sharp");
    const sharp = sharpModule.default;
    return await sharp(bytes, { failOn: "none" }).rotate().toBuffer();
  } catch (error) {
    console.warn("[blob-storage] Failed to strip image metadata, using original bytes:", error);
    return bytes;
  }
}

function asNonEmpty(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseStorageConnectionString(raw: string): StorageAccountConfig {
  if (raw.trim().toLowerCase() === "usedevelopmentstorage=true") {
    throw new Error("UseDevelopmentStorage=true is not supported for source image uploads");
  }

  const parts = raw.split(";").map((segment) => segment.trim()).filter(Boolean);
  const map = new Map<string, string>();
  for (const part of parts) {
    const separator = part.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = part.slice(0, separator);
    const value = part.slice(separator + 1);
    map.set(key, value);
  }

  const accountName = asNonEmpty(map.get("AccountName") || undefined);
  if (!accountName) {
    throw new Error("AZURE_STORAGE_CONNECTION is missing AccountName");
  }

  const endpointProtocol = asNonEmpty(map.get("DefaultEndpointsProtocol") || undefined) || "https";
  const endpointSuffix = asNonEmpty(map.get("EndpointSuffix") || undefined) || "core.windows.net";
  const blobEndpoint =
    asNonEmpty(map.get("BlobEndpoint") || undefined) ||
    `${endpointProtocol}://${accountName}.blob.${endpointSuffix}`;

  const accountKeyRaw = asNonEmpty(map.get("AccountKey") || undefined);
  const sasTokenRaw = asNonEmpty(map.get("SharedAccessSignature") || undefined);

  if (!accountKeyRaw && !sasTokenRaw) {
    throw new Error("AZURE_STORAGE_CONNECTION must include AccountKey or SharedAccessSignature");
  }

  return {
    accountName,
    accountKey: accountKeyRaw ? Buffer.from(accountKeyRaw, "base64") : undefined,
    sasToken: sasTokenRaw || undefined,
    blobEndpoint: blobEndpoint.replace(/\/+$/, ""),
  };
}

function mergeSas(url: URL, sasToken?: string): URL {
  if (!sasToken) {
    return url;
  }
  const token = sasToken.startsWith("?") ? sasToken.slice(1) : sasToken;
  const merged = new URL(url.toString());
  const params = new URLSearchParams(token);
  for (const [key, value] of params.entries()) {
    if (!merged.searchParams.has(key)) {
      merged.searchParams.append(key, value);
    }
  }
  return merged;
}

function canonicalizedHeaders(headers: Record<string, string>): string {
  const entries = Object.entries(headers)
    .map(([key, value]) => [key.toLowerCase(), value.replace(/\s+/g, " ").trim()] as const)
    .filter(([key]) => key.startsWith("x-ms-"))
    .sort(([a], [b]) => a.localeCompare(b));

  if (entries.length === 0) {
    return "";
  }

  return `${entries.map(([key, value]) => `${key}:${value}`).join("\n")}\n`;
}

function canonicalizedResource(accountName: string, url: URL): string {
  let result = `/${accountName}${decodeURIComponent(url.pathname)}`;

  const query = new Map<string, string[]>();
  for (const [key, value] of url.searchParams.entries()) {
    const lowerKey = key.toLowerCase();
    const bucket = query.get(lowerKey) || [];
    bucket.push(value);
    query.set(lowerKey, bucket);
  }

  const keys = [...query.keys()].sort((a, b) => a.localeCompare(b));
  for (const key of keys) {
    const values = (query.get(key) || []).sort((a, b) => a.localeCompare(b));
    result += `\n${key}:${values.join(",")}`;
  }

  return result;
}

function authorizationHeader(
  method: string,
  accountName: string,
  accountKey: Buffer,
  url: URL,
  headers: Record<string, string>
): string {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );
  const contentLengthRaw = lower["content-length"] || "";
  const contentLength =
    contentLengthRaw === "0" || contentLengthRaw === "" ? "" : contentLengthRaw;

  const stringToSign = [
    method.toUpperCase(),
    lower["content-encoding"] || "",
    lower["content-language"] || "",
    contentLength,
    lower["content-md5"] || "",
    lower["content-type"] || "",
    lower.date || "",
    lower["if-modified-since"] || "",
    lower["if-match"] || "",
    lower["if-none-match"] || "",
    lower["if-unmodified-since"] || "",
    lower.range || "",
    canonicalizedHeaders(headers) + canonicalizedResource(accountName, url),
  ].join("\n");

  const signature = createHmac("sha256", accountKey).update(stringToSign, "utf8").digest("base64");
  return `SharedKey ${accountName}:${signature}`;
}

async function runWithTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

/**
 * One Azure Blob Storage REST call over the pooled storage Agent (lib/storage-http).
 *
 * Every non-GET response body is read before returning so its socket goes back to the pool; GET
 * callers read (or `text()`) the body themselves. PUT and HEAD are always retried on transient
 * network errors (a connect timeout, refused or reset connection, no response) and 429/5xx: Put
 * Blob of a checksum-named blob and container creation are idempotent, and fetch only rejects for
 * these methods before a response arrived. GET opts in with `retry` (the successful body is
 * buffered inside the attempt so a reset mid-body is retried too). DELETE is never retried, since
 * a retry after a lost success response would report the blob as missing.
 */
async function sendStorageRequest(
  config: StorageAccountConfig,
  method: "PUT" | "GET" | "HEAD" | "DELETE",
  url: URL,
  headers: Record<string, string>,
  body?: Buffer,
  options: { retry?: boolean } = {}
): Promise<Response> {
  const finalizedUrl = mergeSas(url, config.sasToken);
  const requestBody = body ? new Uint8Array(body) : undefined;

  const send = async () => {
    // Signed per attempt: x-ms-date must be fresh (Storage rejects requests older than 15 min).
    const requestHeaders: Record<string, string> = {
      ...headers,
      "x-ms-date": new Date().toUTCString(),
      "x-ms-version": AZURE_STORAGE_API_VERSION,
    };
    if (!config.sasToken) {
      if (!config.accountKey) {
        throw new Error("Account key missing for storage request");
      }
      requestHeaders.Authorization = authorizationHeader(
        method,
        config.accountName,
        config.accountKey,
        finalizedUrl,
        requestHeaders
      );
    }
    const response = await blobStorageTransport.fetch(finalizedUrl.toString(), {
      method,
      headers: requestHeaders,
      body: requestBody,
      dispatcher: getBlobStorageDispatcher(REQUEST_TIMEOUT_MS),
    });
    return method === "GET" ? response : bufferBody(response);
  };

  const retryOptions = { ...blobStorageRetry, label: `Azure Blob Storage ${method}` };
  if (method === "PUT" || method === "HEAD") {
    return fetchWithRetry(send, retryOptions);
  }
  if (options.retry && method === "GET") {
    return fetchWithRetry(async () => bufferSuccessfulBody(await send()), retryOptions);
  }
  return send();
}

/** Read any response's body now (releasing the socket) and return an equivalent buffered Response. */
async function bufferBody(response: Response): Promise<Response> {
  if (response.body === null) return response;
  const body = await response.arrayBuffer();
  return new Response(body.byteLength > 0 ? body : null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** Read an OK response's body now and return an equivalent, already-buffered Response. */
async function bufferSuccessfulBody(response: Response): Promise<Response> {
  if (!response.ok || response.body === null) return response;
  const body = await response.arrayBuffer();
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function normalizeContainerName(
  value: string | undefined,
  fallback: string = DEFAULT_SOURCE_IMAGE_CONTAINER
): string {
  const normalized = (value || fallback).trim().toLowerCase();
  return normalized.length > 0 ? normalized : fallback;
}

function inferExtension(contentType: string, sourceUrl: string): string {
  if (contentType.includes("png")) return "png";
  if (contentType.includes("webp")) return "webp";
  if (contentType.includes("gif")) return "gif";
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return "jpg";

  const path = new URL(sourceUrl).pathname;
  const dot = path.lastIndexOf(".");
  if (dot >= 0 && dot < path.length - 1) {
    const ext = path.slice(dot + 1).toLowerCase();
    if (/^[a-z0-9]{2,5}$/.test(ext)) {
      return ext;
    }
  }
  return "jpg";
}

function buildBlobName(source: string, externalId: string, checksumSha256: string, extension: string): string {
  const safeSource = source.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const safeExternal = externalId.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  return `${safeSource}/${safeExternal}-${checksumSha256.slice(0, 12)}.${extension}`;
}

function encodeBlobPath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function parseStorageUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Invalid blob storage URL");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Unsupported blob storage URL protocol");
  }

  return parsed;
}

/**
 * A storage URL points outside what the API is allowed to read (wrong account/host, wrong
 * container, or carries query/credential components that would change the storage operation).
 */
export class BlobAccessDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlobAccessDeniedError";
  }
}

function assertStorageHostMatches(config: StorageAccountConfig, storageUrl: URL): void {
  const configuredHost = new URL(config.blobEndpoint).host.toLowerCase();
  const storageHost = storageUrl.host.toLowerCase();

  if (configuredHost !== storageHost) {
    throw new BlobAccessDeniedError(
      `Blob storage URL host mismatch: expected ${configuredHost}, got ${storageHost}`
    );
  }
}

/**
 * Restrict reads to plain blob GETs inside an allowlisted container of the configured account.
 * Rejects query strings (e.g. `?comp=list&restype=container`), fragments, embedded credentials,
 * protocol downgrades, and paths outside `<blobEndpoint>/<allowed-container>/<blob>`.
 */
function assertStorageReadAllowed(
  config: StorageAccountConfig,
  storageUrl: URL,
  allowedContainers: readonly string[]
): void {
  const endpoint = new URL(config.blobEndpoint);
  assertStorageHostMatches(config, storageUrl);

  if (storageUrl.protocol !== endpoint.protocol) {
    throw new BlobAccessDeniedError("Blob storage URL protocol does not match the configured endpoint");
  }
  if (storageUrl.username || storageUrl.password) {
    throw new BlobAccessDeniedError("Blob storage URL must not include credentials");
  }
  if (storageUrl.search || storageUrl.hash) {
    throw new BlobAccessDeniedError("Blob storage URL must not include a query string or fragment");
  }

  const endpointPath = endpoint.pathname.replace(/\/+$/, "");
  if (!storageUrl.pathname.startsWith(`${endpointPath}/`)) {
    throw new BlobAccessDeniedError("Blob storage URL is outside the configured blob endpoint");
  }
  const segments = storageUrl.pathname.slice(endpointPath.length + 1).split("/");
  const container = (segments[0] || "").toLowerCase();
  const blobPath = segments.slice(1).join("/");
  if (!container || !blobPath) {
    throw new BlobAccessDeniedError("Blob storage URL must reference a blob inside a container");
  }

  const allowed = new Set(allowedContainers.map((name) => normalizeContainerName(name)));
  if (!allowed.has(container)) {
    throw new BlobAccessDeniedError(`Blob container '${container}' is not readable through the API`);
  }
}

/**
 * Host (including any non-default port) of the configured storage account's blob endpoint,
 * lowercased, or null when AZURE_STORAGE_CONNECTION is unset or unparseable (fail closed).
 */
export function getConfiguredBlobHost(): string | null {
  const connectionString = asNonEmpty(process.env.AZURE_STORAGE_CONNECTION);
  if (!connectionString) {
    return null;
  }
  try {
    return new URL(parseStorageConnectionString(connectionString).blobEndpoint).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Decide whether a client-supplied remote image URL may be stored and forwarded to AI/OCR
 * services. Only plain `https://<configured-account-blob-host>/<allowed-container>/<blob>` URLs
 * qualify: no userinfo, no non-default port, no query string/fragment (so no SAS/list tricks),
 * and the container must be one the API itself writes images to (`SOURCE_IMAGE_CONTAINER`
 * by default). Returns a reason string when rejected, or null when accepted.
 * Fails closed when no storage account is configured.
 */
export function checkStorageImageUrl(
  value: string,
  allowedContainers: readonly string[] = defaultReadableContainers()
): string | null {
  const connectionString = asNonEmpty(process.env.AZURE_STORAGE_CONNECTION);
  if (!connectionString) {
    return "no storage account is configured";
  }

  let config: StorageAccountConfig;
  try {
    config = parseStorageConnectionString(connectionString);
  } catch {
    return "no storage account is configured";
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "not a valid URL";
  }

  if (parsed.protocol !== "https:") {
    return "URL must use https";
  }
  if (parsed.username || parsed.password) {
    return "URL must not include credentials";
  }
  if (parsed.port) {
    return "URL must not specify a port";
  }
  try {
    assertStorageReadAllowed(config, parsed, allowedContainers);
  } catch (error) {
    return error instanceof BlobAccessDeniedError ? error.message : "URL is not allowed";
  }
  return null;
}

export interface ReadBlobResult {
  bytes: Buffer;
  contentType: string;
  cacheControl: string | null;
  etag: string | null;
  lastModified: string | null;
}

export class BlobReadError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "BlobReadError";
  }
}

export interface ReadBlobOptions {
  /**
   * Containers this read may target. Defaults to the source-image container
   * (`SOURCE_IMAGE_CONTAINER`, default `source-images`).
   */
  allowedContainers?: readonly string[];
  /**
   * Retry transient network errors and 429/5xx (`fetchWithRetry`). Off by default so latency-
   * sensitive reads such as the image proxy fall back at once; batch jobs (the variants backfill)
   * turn it on.
   */
  retry?: boolean;
}

export function defaultReadableContainers(): string[] {
  return [normalizeContainerName(process.env.SOURCE_IMAGE_CONTAINER)];
}

/**
 * True when the blob lives in the shared catalog/source-image container (public product imagery,
 * see `defaultReadableContainers()`). Anything else (e.g. user-uploaded media) must never be
 * stored by shared caches, and is only proxied through owner-scoped `v3` image ids (#227).
 * Handles virtual-host style (`<account>.blob.core.windows.net/<container>/...`) and path-style
 * (Azurite: `host/<account>/<container>/...`) endpoints. Unparseable URLs are not catalog URLs.
 */
export function isCatalogStorageUrl(storageUrl: string): boolean {
  const container = storageUrlContainer(storageUrl);
  return container.length > 0 && defaultReadableContainers().includes(container);
}

/**
 * True when the blob lives in the private user-media container (`userMediaContainer()`), using the
 * same virtual-host / path-style parsing as `isCatalogStorageUrl`. Unparseable URLs are not.
 *
 * @throws ImageProxyConfigError when USER_MEDIA_CONTAINER equals SOURCE_IMAGE_CONTAINER.
 */
export function isUserMediaStorageUrl(storageUrl: string): boolean {
  const mediaContainer = userMediaContainer();
  const container = storageUrlContainer(storageUrl);
  return container.length > 0 && container === mediaContainer;
}

/** Lowercased container segment of a blob URL, or "" when there is none / the URL is invalid. */
/** Container and blob-name segments of a storage URL (path-style Azurite URLs carry the account first). */
function storageUrlSegments(storageUrl: string): { container: string; blobSegments: string[] } {
  let parsed: URL;
  try {
    parsed = new URL(storageUrl);
  } catch {
    return { container: "", blobSegments: [] };
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  const containerIndex = /^[^.]+\.blob\./i.test(parsed.hostname) ? 0 : 1;
  return {
    container: (segments[containerIndex] ?? "").toLowerCase(),
    blobSegments: segments.slice(containerIndex + 1).map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    }),
  };
}

function storageUrlContainer(storageUrl: string): string {
  return storageUrlSegments(storageUrl).container;
}

/** Blob name (path inside its container) of a storage URL, or "" when it cannot be parsed. */
export function storageUrlBlobName(storageUrl: string): string {
  return storageUrlSegments(storageUrl).blobSegments.join("/");
}

/**
 * Container for private user media (e.g. nail photos, #270), from `USER_MEDIA_CONTAINER`
 * (default `nail-photos`). Blobs here are never readable through public `v2` proxy ids; they are
 * served only through owner-scoped `v3` proxy ids (#227).
 *
 * @throws ImageProxyConfigError when it equals the catalog container (`SOURCE_IMAGE_CONTAINER`):
 *   proxy scope is decided by "is it the catalog container", so a shared container would make
 *   every user photo public. Minting and the private read path both fail closed on it.
 */
export function userMediaContainer(): string {
  const container = normalizeContainerName(process.env.USER_MEDIA_CONTAINER, DEFAULT_USER_MEDIA_CONTAINER);
  if (defaultReadableContainers().includes(container)) {
    throw new ImageProxyConfigError(
      `USER_MEDIA_CONTAINER must differ from SOURCE_IMAGE_CONTAINER (both are '${container}')`
    );
  }
  return container;
}

/**
 * Read a blob from the configured storage account using the Functions' storage credentials.
 *
 * Only plain blob URLs on the configured account, inside an allowlisted container, are accepted;
 * anything else throws `BlobAccessDeniedError` before any request is made.
 */
export async function readBlobFromStorageUrl(
  storageUrl: string,
  options: ReadBlobOptions = {}
): Promise<ReadBlobResult> {
  const connectionString = asNonEmpty(process.env.AZURE_STORAGE_CONNECTION);
  if (!connectionString) {
    throw new Error("AZURE_STORAGE_CONNECTION is required for source image reads");
  }

  const config = parseStorageConnectionString(connectionString);
  const parsedStorageUrl = parseStorageUrl(storageUrl);
  assertStorageReadAllowed(
    config,
    parsedStorageUrl,
    options.allowedContainers ?? defaultReadableContainers()
  );

  const response = await sendStorageRequest(config, "GET", parsedStorageUrl, {}, undefined, {
    retry: options.retry,
  });
  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new BlobReadError(
      `Blob read failed: ${response.status} ${response.statusText} ${details}`.trim(),
      response.status
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  const bytes = Buffer.from(arrayBuffer);
  if (bytes.length === 0) {
    throw new Error("Blob read returned empty body");
  }

  return {
    bytes,
    contentType: response.headers.get("content-type") || "application/octet-stream",
    cacheControl: response.headers.get("cache-control"),
    etag: response.headers.get("etag"),
    lastModified: response.headers.get("last-modified"),
  };
}

/**
 * Delete a blob by its storage URL. Same guard as `readBlobFromStorageUrl`: only plain blob URLs on
 * the configured account inside one of `allowedContainers` (required, so a caller can never
 * default to deleting catalog imagery) are accepted; anything else throws `BlobAccessDeniedError`
 * before any request is made.
 *
 * @returns true when the blob was deleted, false when it did not exist (404).
 * @throws on any other storage error.
 */
export async function deleteBlobFromStorageUrl(
  storageUrl: string,
  options: { allowedContainers: readonly string[] }
): Promise<boolean> {
  const connectionString = asNonEmpty(process.env.AZURE_STORAGE_CONNECTION);
  if (!connectionString) {
    throw new Error("AZURE_STORAGE_CONNECTION is required for blob deletes");
  }

  const config = parseStorageConnectionString(connectionString);
  const parsedStorageUrl = parseStorageUrl(storageUrl);
  assertStorageReadAllowed(config, parsedStorageUrl, options.allowedContainers);

  const response = await sendStorageRequest(config, "DELETE", parsedStorageUrl, {});
  if (response.status === 202 || response.status === 200) {
    return true;
  }
  if (response.status === 404) {
    return false;
  }
  const details = await response.text().catch(() => "");
  throw new Error(`Blob delete failed: ${response.status} ${response.statusText} ${details}`.trim());
}

export async function blobExists(
  connectionString: string,
  containerName: string,
  blobName: string
): Promise<boolean> {
  const config = parseStorageConnectionString(connectionString);
  const container = normalizeContainerName(containerName);
  const blobUrl = new URL(
    `${config.blobEndpoint}/${container}/${encodeBlobPath(blobName)}`
  );
  const response = await sendStorageRequest(config, "HEAD", blobUrl, {});

  if (response.status === 200) {
    return true;
  }

  if (response.status === 404) {
    return false;
  }

  const details = await response.text().catch(() => "");
  throw new Error(
    `Failed to check blob existence for '${container}/${blobName}': ${response.status} ${response.statusText} ${details}`.trim()
  );
}

export async function ensureContainer(
  connectionString: string,
  containerName: string
): Promise<void> {
  const config = parseStorageConnectionString(connectionString);
  const container = normalizeContainerName(containerName);
  const containerUrl = new URL(`${config.blobEndpoint}/${container}`);
  const response = await sendStorageRequest(
    config,
    "PUT",
    new URL(`${containerUrl.toString()}?restype=container`),
    { "Content-Length": "0" }
  );
  if (![201, 202, 409].includes(response.status)) {
    const details = await response.text().catch(() => "");
    throw new Error(
      `Failed to ensure blob container '${container}': ${response.status} ${details}`
    );
  }
}

function urlHost(value: string): string | null {
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}

/** Run `fn`, rethrowing any failure as a `SourceImageUploadError` for `step`. */
async function atUploadStep<T>(step: SourceImageUploadStep, host: string | null, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw error instanceof SourceImageUploadError ? error : new SourceImageUploadError(step, host, error);
  }
}

/**
 * Download a vendor image, normalize it and store it (plus its thumbnail variants) in the source
 * image container. Every failure is a `SourceImageUploadError` naming the failed step.
 */
export async function uploadSourceImageToBlob(
  params: UploadSourceImageOptions & { skipContainerEnsure?: boolean }
): Promise<UploadedBlobImage> {
  console.log(`[blob-storage] Downloading image from ${params.sourceImageUrl}`);
  const sourceHost = urlHost(params.sourceImageUrl);
  const limits = resolveSourceImageLimits();
  let sourceType = "";
  let bytes: Buffer = Buffer.alloc(0);
  // Each attempt gets its own REQUEST_TIMEOUT_MS; transient network errors (also while reading the
  // body, which is why the capped read happens inside the attempt) and 429/5xx are retried.
  const sourceResponse = await atUploadStep("source_download", sourceHost, () => fetchWithRetry(
    async () => {
      const response = await runWithTimeout(
        fetch(params.sourceImageUrl, {
          method: "GET",
          headers: { "User-Agent": "SwatchWatch/source-image-ingestion" },
        }),
        REQUEST_TIMEOUT_MS,
        "Source image download"
      );
      if (!response.ok) return response;
      try {
        sourceType = assertAllowedImageType(response.headers.get("content-type") || "image/jpeg");
      } catch (error) {
        await response.body?.cancel().catch(() => undefined);
        throw error;
      }
      bytes = await readResponseCapped(response, limits.maxDownloadBytes);
      return response;
    },
    { label: "Source image download" }
  ));

  if (!sourceResponse.ok) {
    throw new SourceImageUploadError(
      "source_download",
      sourceHost,
      new Error(`Failed to download source image: ${sourceResponse.status} ${sourceResponse.statusText}`)
    );
  }
  if (bytes.length === 0) {
    throw new SourceImageUploadError("source_download", sourceHost, new Error("Image payload is empty"));
  }
  // Oversize images are downscaled/re-encoded rather than rejected; UPLOAD_LIMITS.maxSizeBytes
  // still guards what is stored (and handed to AI vision as a data URI).
  const normalized = await atUploadStep("image_processing", null, () =>
    normalizeSourceImage(bytes, sourceType, { maxEdgePx: limits.maxEdgePx })
  );
  const contentType = await atUploadStep("image_processing", null, async () =>
    validateImageUpload(normalized.contentType, normalized.bytes.length)
  );
  const cleanBytes = normalized.bytes;
  if (normalized.resized || normalized.reencoded) {
    console.log(
      `[blob-storage] Normalized oversize image for ${params.source}:${params.externalId}: ${formatMb(bytes.length)}MB ${sourceType} → ${formatMb(cleanBytes.length)}MB ${contentType}${normalized.resized ? ` (long edge capped at ${limits.maxEdgePx}px)` : ""}`
    );
  }

  const checksumSha256 = createHash("sha256").update(cleanBytes).digest("hex");
  // Fingerprinted from exactly the bytes stored, like the checksum; a decode failure just leaves it null.
  const fingerprint = await computeImageFingerprintSafely(cleanBytes);
  const includeBase64DataUri = params.includeBase64DataUri === true;
  const imageBase64DataUri = includeBase64DataUri
    ? `data:${contentType};base64,${cleanBytes.toString("base64")}`
    : null;
  const connectionString = asNonEmpty(process.env.AZURE_STORAGE_CONNECTION);

  // If storage isn't configured (e.g., local dev), fall back to the source URL so we can still
  // associate images with records and display source assets.
  if (!connectionString) {
    console.warn(
      `[blob-storage] AZURE_STORAGE_CONNECTION not configured; using source image URL directly for ${params.source}:${params.externalId}`
    );
    return {
      storageUrl: params.sourceImageUrl,
      checksumSha256,
      contentType,
      sizeBytes: cleanBytes.length,
      imageBase64DataUri,
      fingerprint,
    };
  }

  const config = parseStorageConnectionString(connectionString);
  const containerName = normalizeContainerName(process.env.SOURCE_IMAGE_CONTAINER);
  const extension = inferExtension(contentType, params.sourceImageUrl);
  const blobName = buildBlobName(params.source, params.externalId, checksumSha256, extension);

  console.log(
    `[blob-storage] Image downloaded: ${bytes.length} bytes (${cleanBytes.length} after metadata strip), checksum=${checksumSha256}, extension=${extension}`
  );

  const containerUrl = new URL(`${config.blobEndpoint}/${containerName}`);
  if (!params.skipContainerEnsure) {
    console.log(`[blob-storage] Ensuring container exists: ${containerName}`);
    await atUploadStep("blob_put", containerUrl.host, () => ensureContainer(connectionString, containerName));
  }

  const blobUrl = new URL(`${containerUrl.toString()}/${encodeBlobPath(blobName)}`);

  // The blob name embeds the content checksum, so an existing blob already holds these bytes
  // (re-ingesting an unchanged catalog). A failed check just falls through to the upload.
  const alreadyStored = await blobExists(connectionString, containerName, blobName).catch(() => false);
  if (alreadyStored) {
    console.log(`[blob-storage] Blob already stored, skipping upload: ${blobName}`);
    // Re-ingesting an unchanged image also fills in thumbnails it is missing (e.g. stored before
    // variants existed), so a catalog re-sync doubles as a variant backfill.
    await ensureImageVariantsSafely({ connectionString, containerName, blobName, bytes: cleanBytes });
    return {
      storageUrl: blobUrl.toString(),
      checksumSha256,
      contentType,
      sizeBytes: cleanBytes.length,
      imageBase64DataUri,
      fingerprint,
    };
  }

  console.log(`[blob-storage] Uploading blob: ${blobName}`);
  await atUploadStep("blob_put", blobUrl.host, async () => {
    const uploadResponse = await sendStorageRequest(
      config,
      "PUT",
      blobUrl,
      {
        "Content-Type": contentType,
        "Content-Length": String(cleanBytes.length),
        "x-ms-blob-type": "BlockBlob",
      },
      cleanBytes
    );
    if (uploadResponse.status !== 201) {
      const details = await uploadResponse.text().catch(() => "");
      throw new Error(`Blob upload failed: ${uploadResponse.status} ${details}`.trim());
    }
  });

  console.log(`[blob-storage] Blob uploaded successfully: ${blobUrl.toString()}`);
  await ensureImageVariantsSafely({ connectionString, containerName, blobName, bytes: cleanBytes });

  return {
    storageUrl: blobUrl.toString(),
    checksumSha256,
    contentType,
    sizeBytes: cleanBytes.length,
    imageBase64DataUri,
    fingerprint,
  };
}

export interface EnsureImageVariantsResult {
  /** Variant sizes uploaded by this call. */
  written: ImageVariantSize[];
  /** Variant sizes that were already stored (skipped). */
  existing: ImageVariantSize[];
  /** Variant sizes that could not be rendered or uploaded. */
  failed: ImageVariantSize[];
}

/**
 * Make sure every pre-generated thumbnail (`IMAGE_VARIANT_SIZES`, see lib/image-variants) of the
 * catalog blob `blobName` exists, rendering only the missing ones from `bytes` (the stored
 * original, or a loader that is only called when something is missing, so a backfill never reads
 * an original whose variants are complete). Idempotent: a variant blob is a pure function of the
 * checksum-named original, so an existing one is never rewritten. A failed existence check counts
 * as missing (the PUT just overwrites with identical bytes); a size that fails to render or upload
 * is reported in `failed` and the others still proceed.
 *
 * @throws only when the `bytes` loader throws.
 */
export async function ensureImageVariants(params: {
  connectionString: string;
  containerName: string;
  blobName: string;
  bytes: Buffer | (() => Promise<Buffer>);
  sizes?: readonly ImageVariantSize[];
}): Promise<EnsureImageVariantsResult> {
  const sizes = params.sizes ?? IMAGE_VARIANT_SIZES;
  const present = await Promise.all(
    sizes.map((size) =>
      blobExists(params.connectionString, params.containerName, imageVariantBlobName(params.blobName, size)).catch(
        () => false
      )
    )
  );

  const result: EnsureImageVariantsResult = { written: [], existing: [], failed: [] };
  const missing: ImageVariantSize[] = [];
  sizes.forEach((size, index) => (present[index] ? result.existing : missing).push(size));
  if (missing.length === 0) return result;

  const original = typeof params.bytes === "function" ? await params.bytes() : params.bytes;
  const crop = await planImageVariantCrop(original);
  // One size at a time: each ingest worker already uploads several products in parallel, and
  // parallel variant PUTs multiplied the sockets opened to the storage account (see lib/storage-http).
  for (const size of missing) {
    let variant: Buffer;
    try {
      variant = await renderImageVariant(original, size, crop);
    } catch (error) {
      console.warn(`[blob-storage] Failed to render ${size}px variant of ${params.blobName}:`, describeFetchError(error));
      result.failed.push(size);
      continue;
    }
    try {
      await uploadBytesToBlob({
        connectionString: params.connectionString,
        containerName: params.containerName,
        blobName: imageVariantBlobName(params.blobName, size),
        bytes: variant,
        contentType: "image/webp",
        skipContainerEnsure: true,
      });
      result.written.push(size);
    } catch (error) {
      const host = urlHost(parseStorageConnectionString(params.connectionString).blobEndpoint);
      console.warn(
        `[blob-storage] Variant write (${host ?? "blob storage"}) failed for ${size}px variant of ${params.blobName}:`,
        describeFetchError(error)
      );
      result.failed.push(size);
    }
  }
  result.written.sort((a, b) => a - b);
  result.failed.sort((a, b) => a - b);
  return result;
}

/** Ingest-path wrapper: thumbnails are an optimization, so a failure never fails the upload. */
async function ensureImageVariantsSafely(params: {
  connectionString: string;
  containerName: string;
  blobName: string;
  bytes: Buffer;
}): Promise<void> {
  try {
    const { written } = await ensureImageVariants(params);
    if (written.length > 0) {
      console.log(`[blob-storage] Stored ${written.join("/")}px variants of ${params.blobName}`);
    }
  } catch (error) {
    console.warn(`[blob-storage] Failed to store variants of ${params.blobName}:`, error);
  }
}

/**
 * Upload arbitrary bytes to a blob storage container.
 * Low-level generic upload — no image validation or metadata stripping.
 *
 * @returns The full blob URL on success.
 * @throws On upload failure (caller should catch and handle gracefully).
 */
export async function uploadBytesToBlob(params: {
  connectionString: string;
  containerName: string;
  blobName: string;
  bytes: Buffer;
  contentType: string;
  contentEncoding?: string;
  skipContainerEnsure?: boolean;
}): Promise<string> {
  const config = parseStorageConnectionString(params.connectionString);
  const container = normalizeContainerName(params.containerName);
  if (!params.skipContainerEnsure) {
    await ensureContainer(params.connectionString, params.containerName);
  }
  const blobUrl = new URL(`${config.blobEndpoint}/${container}/${encodeBlobPath(params.blobName)}`);
  const response = await sendStorageRequest(
    config,
    "PUT",
    blobUrl,
    {
      "Content-Type": params.contentType,
      ...(params.contentEncoding ? { "Content-Encoding": params.contentEncoding } : {}),
      "Content-Length": String(params.bytes.length),
      "x-ms-blob-type": "BlockBlob",
    },
    params.bytes
  );
  if (response.status !== 201) {
    const details = await response.text().catch(() => "");
    throw new Error(`Blob upload failed for '${container}/${params.blobName}': ${response.status} ${details}`);
  }
  return blobUrl.toString();
}
