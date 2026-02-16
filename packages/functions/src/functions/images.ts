import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { BlobReadError, readBlobFromStorageUrl } from "../lib/blob-storage";
import { decodeImageProxyId } from "../lib/image-proxy";
import { withCors } from "../lib/http";

/**
 * Proxy private blob-backed swatch images
 * GET /api/images/:id
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
          body: JSON.stringify({ error: "Missing image ID" }),
        };
      }

      const storageUrl = decodeImageProxyId(id);
      const blob = await readBlobFromStorageUrl(storageUrl);

      const headers = new Headers({
        "Content-Type": blob.contentType,
        "Cache-Control": blob.cacheControl || "public, max-age=3600",
      });
      if (blob.etag) headers.set("ETag", blob.etag);
      if (blob.lastModified) headers.set("Last-Modified", blob.lastModified);

      return {
        status: 200,
        headers,
        body: blob.bytes,
      };
    } catch (error) {
      if (error instanceof TypeError || (error instanceof Error && error.message.includes("Invalid proxied image URL"))) {
        return {
          status: 400,
          body: JSON.stringify({ error: "Invalid image URL token" }),
        };
      }

      if (error instanceof BlobReadError && error.status === 404) {
        return {
          status: 404,
          body: JSON.stringify({ error: "Image not found" }),
        };
      }

      context.error(`[images] Error serving image:`, error);
      return {
        status: 500,
        body: JSON.stringify({ error: "Failed to serve image" }),
      };
    }
    }
  ),
});
