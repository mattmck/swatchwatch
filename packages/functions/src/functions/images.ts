import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { createHash } from "node:crypto";
import { BlobAccessDeniedError, BlobReadError, readBlobFromStorageUrl } from "../lib/blob-storage";
import { decodeImageProxyId, ImageProxyConfigError, ImageProxyTokenError } from "../lib/image-proxy";
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
 * (see lib/image-proxy.ts). Unsigned, forged, or tampered ids are rejected with 403, and the
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

      const storageUrl = decodeImageProxyId(id);
      const blob = await readBlobFromStorageUrl(storageUrl);
      const transform = parseTransformOptions(request.url);

      let bodyBytes = blob.bytes;
      let contentType = blob.contentType;
      let cacheControl = blob.cacheControl || "public, max-age=3600";
      let etag = blob.etag;

      if (hasTransformRequest(transform) && isTransformableContentType(blob.contentType)) {
        const transformed = await transformImage(blob.bytes, transform);
        bodyBytes = transformed.bytes;
        contentType = transformed.contentType;
        cacheControl = "public, max-age=86400, stale-while-revalidate=604800";
        etag = `"${createHash("sha1").update(bodyBytes).digest("hex")}"`;
      }

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
