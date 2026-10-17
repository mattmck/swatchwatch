import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { createHash } from "node:crypto";
import {
  BlobAccessDeniedError,
  BlobReadError,
  defaultReadableContainers,
  readBlobFromStorageUrl,
} from "../lib/blob-storage";
import {
  decodeImageProxyIdWithExpiry,
  ImageProxyConfigError,
  ImageProxyTokenError,
} from "../lib/image-proxy";
import { withCors } from "../lib/http";
import sharp from "sharp";

type ImageFormat = "webp" | "jpeg" | "png";
type ImageFit = "cover" | "contain" | "inside";

const ALLOWED_FITS: ReadonlySet<ImageFit> = new Set(["cover", "contain", "inside"]);
const ALLOWED_FORMATS: ReadonlySet<ImageFormat> = new Set(["webp", "jpeg", "png"]);

interface TransformOptions {
  width?: number;
  height?: number;
  quality: number;
  fit: ImageFit;
  format?: ImageFormat;
}

function parseClampedInt(
  raw: string | null,
  min: number,
  max: number
): number | undefined {
  if (!raw) return undefined;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return undefined;
  return Math.min(max, Math.max(min, value));
}

function parseTransformOptions(requestUrl: string): TransformOptions {
  const params = new URL(requestUrl).searchParams;
  const width = parseClampedInt(params.get("w"), 16, 1024);
  const height = parseClampedInt(params.get("h"), 16, 1024);
  const quality = parseClampedInt(params.get("q"), 1, 100) ?? 72;
  const fitCandidate = (params.get("fit") ?? "cover").toLowerCase() as ImageFit;
  const fit: ImageFit = ALLOWED_FITS.has(fitCandidate) ? fitCandidate : "cover";
  const formatCandidate = params.get("fm")?.toLowerCase() as ImageFormat | undefined;
  const format = formatCandidate && ALLOWED_FORMATS.has(formatCandidate) ? formatCandidate : undefined;

  return { width, height, quality, fit, format };
}

function hasTransformRequest(options: TransformOptions): boolean {
  return Boolean(options.width || options.height || options.format);
}

const DEFAULT_MAX_AGE_SECONDS = 3600;
const TRANSFORM_MAX_AGE_SECONDS = 86400;
const TRANSFORM_STALE_WHILE_REVALIDATE_SECONDS = 604800;

/**
 * True when the blob lives in the shared catalog/source-image container (public product imagery).
 * Anything else (e.g. user-uploaded media) must never be stored by shared caches.
 * Handles virtual-host style (`<account>.blob.core.windows.net/<container>/...`) and path-style
 * (Azurite: `host/<account>/<container>/...`) endpoints.
 */
export function isCatalogImageUrl(storageUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(storageUrl);
  } catch {
    return false;
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  const virtualHost = /^[^.]+\.blob\./i.test(parsed.hostname);
  const container = (segments[virtualHost ? 0 : 1] ?? "").toLowerCase();
  return container.length > 0 && defaultReadableContainers().includes(container);
}

const FRESHNESS_DIRECTIVES = new Set(["max-age", "s-maxage"]);
// RFC 5861 stale windows: both let a cache keep serving after freshness ends.
const STALE_DIRECTIVES = new Set(["stale-while-revalidate", "stale-if-error"]);

/**
 * Keep a blob's own private/no-cache directive, but make sure its lifetimes cannot outlive the
 * signed id: max-age / s-maxage are capped at `remaining`, and the stale windows
 * (stale-while-revalidate, stale-if-error) at whatever is left after the longest freshness
 * window (dropped when nothing is left). Directive arguments
 * may be quoted (RFC 9111), so the header is parsed rather than pattern-matched; a lifetime whose
 * argument is not a non-negative integer is treated as 0 (fail closed).
 */
function capPassthroughCacheControl(header: string, remaining: number): string {
  const directives = header
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const eq = part.indexOf("=");
      const name = (eq === -1 ? part : part.slice(0, eq)).trim();
      const rawValue = eq === -1 ? null : part.slice(eq + 1).trim().replace(/^"(.*)"$/, "$1");
      return { name, key: name.toLowerCase(), rawValue };
    });

  const seconds = (rawValue: string | null): number =>
    rawValue !== null && /^\d+$/.test(rawValue) ? Number.parseInt(rawValue, 10) : 0;

  let freshFor = 0;
  for (const d of directives) {
    if (FRESHNESS_DIRECTIVES.has(d.key)) {
      freshFor = Math.max(freshFor, Math.min(seconds(d.rawValue), remaining));
    }
  }

  const out: string[] = [];
  for (const d of directives) {
    if (STALE_DIRECTIVES.has(d.key)) {
      const stale = Math.min(seconds(d.rawValue), remaining - freshFor);
      if (stale > 0) out.push(`${d.name}=${stale}`);
    } else if (!FRESHNESS_DIRECTIVES.has(d.key)) {
      out.push(d.rawValue === null ? d.name : `${d.name}=${d.rawValue}`);
    } else {
      out.push(`${d.name}=${Math.min(seconds(d.rawValue), remaining)}`);
    }
  }
  return out.join(", ");
}

/**
 * Choose the Cache-Control header for a proxied image.
 *
 * - Catalog blobs: `public`, honoring the blob's own max-age (default 1h; 1d + SWR for transforms).
 * - Everything else: `private, max-age=<n>` only, no `public` and no stale-while-revalidate;
 *   the blob's own cacheControl is ignored.
 * - max-age (and SWR) never outlive the signed id: the browser must not keep serving an image
 *   past the point where the capability URL stops working.
 */
export function selectImageCacheControl(params: {
  catalog: boolean;
  transformed: boolean;
  blobCacheControl?: string | null;
  expiresAt: number;
  nowMs?: number;
}): string {
  const nowSeconds = Math.floor((params.nowMs ?? Date.now()) / 1000);
  const remaining = Math.max(0, params.expiresAt - nowSeconds);

  const blobDirective = params.blobCacheControl?.toLowerCase() ?? "";
  if (params.catalog && !params.transformed && /\b(no-store|no-cache|private)\b/.test(blobDirective)) {
    return capPassthroughCacheControl(params.blobCacheControl as string, remaining);
  }

  let maxAge = params.transformed ? TRANSFORM_MAX_AGE_SECONDS : DEFAULT_MAX_AGE_SECONDS;
  if (params.catalog && !params.transformed) {
    const match = blobDirective.match(/max-age=(\d+)/);
    if (match) maxAge = Number.parseInt(match[1], 10);
  }
  maxAge = Math.min(maxAge, remaining);

  if (!params.catalog) {
    return `private, max-age=${maxAge}`;
  }
  if (params.transformed) {
    const swr = Math.min(TRANSFORM_STALE_WHILE_REVALIDATE_SECONDS, remaining - maxAge);
    if (swr > 0) return `public, max-age=${maxAge}, stale-while-revalidate=${swr}`;
  }
  return `public, max-age=${maxAge}`;
}

function isTransformableContentType(contentType: string): boolean {
  const normalized = contentType.toLowerCase();
  return normalized.includes("image/jpeg")
    || normalized.includes("image/jpg")
    || normalized.includes("image/png")
    || normalized.includes("image/webp")
    || normalized.includes("image/gif")
    || normalized.includes("image/heic")
    || normalized.includes("image/heif");
}

async function transformImage(
  bytes: Buffer,
  options: TransformOptions
): Promise<{ bytes: Buffer; contentType: string }> {
  const pipeline = sharp(bytes, { failOn: "none" }).rotate();
  if (options.width || options.height) {
    pipeline.resize({
      width: options.width,
      height: options.height,
      fit: options.fit,
      withoutEnlargement: true,
    });
  }

  const format = options.format ?? "webp";
  switch (format) {
    case "jpeg":
      return {
        bytes: await pipeline.jpeg({ quality: options.quality }).toBuffer(),
        contentType: "image/jpeg",
      };
    case "png":
      return {
        bytes: await pipeline.png().toBuffer(),
        contentType: "image/png",
      };
    case "webp":
    default:
      return {
        bytes: await pipeline.webp({ quality: options.quality }).toBuffer(),
        contentType: "image/webp",
      };
  }
}

/**
 * Proxy private blob-backed swatch images
 * GET /api/images/:id
 *
 * Anonymous by design (ids are embedded in <img src>, which cannot send Authorization headers),
 * so the id itself is the capability: it must be an HMAC-signed id minted by the API
 * (see lib/image-proxy.ts). Unsigned, forged, tampered, or expired ids are rejected with 403, and the
 * decoded URL must still point at an allowlisted container of the configured storage account.
 */
app.http("images", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "images/{id}",
  handler: withCors(
    async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
    try {
      const id = request.params.id;

      if (!id) {
        return {
          status: 400,
          jsonBody: { error: "Missing image ID" },
        };
      }

      const { url: storageUrl, expiresAt } = decodeImageProxyIdWithExpiry(id);
      const blob = await readBlobFromStorageUrl(storageUrl);
      const transform = parseTransformOptions(request.url);

      let bodyBytes = blob.bytes;
      let contentType = blob.contentType;
      let transformed = false;
      let etag = blob.etag;

      if (hasTransformRequest(transform) && isTransformableContentType(blob.contentType)) {
        const result = await transformImage(blob.bytes, transform);
        bodyBytes = result.bytes;
        contentType = result.contentType;
        transformed = true;
        etag = `"${createHash("sha1").update(bodyBytes).digest("hex")}"`;
      }

      const cacheControl = selectImageCacheControl({
        catalog: isCatalogImageUrl(storageUrl),
        transformed,
        blobCacheControl: blob.cacheControl,
        expiresAt,
      });

      const headers = new Headers({
        "Content-Type": contentType,
        "Cache-Control": cacheControl,
      });
      if (etag) headers.set("ETag", etag);
      if (blob.lastModified) headers.set("Last-Modified", blob.lastModified);

      return {
        status: 200,
        headers,
        body: bodyBytes,
      };
    } catch (error) {
      if (error instanceof ImageProxyTokenError || error instanceof BlobAccessDeniedError) {
        if (error instanceof BlobAccessDeniedError) {
          // A validly signed id that points outside the readable containers indicates a
          // server-side bug or key compromise; log it, but never echo details to the caller.
          context.warn(`[images] Refused signed image read: ${error.message}`);
        }
        return {
          status: 403,
          jsonBody: { error: "Forbidden" },
        };
      }

      if (error instanceof ImageProxyConfigError) {
        context.error(`[images] Image proxy signing is not configured: ${error.message}`);
        return {
          status: 500,
          jsonBody: { error: "Failed to serve image" },
        };
      }

      if (error instanceof BlobReadError && error.status === 404) {
        return {
          status: 404,
          jsonBody: { error: "Image not found" },
        };
      }

      context.error(`[images] Error serving image:`, error);
      return {
        status: 500,
        jsonBody: { error: "Failed to serve image" },
      };
    }
    }
  ),
});
