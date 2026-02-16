import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";

/**
 * Serve swatch images from blob storage
 * GET /api/images/:id
 *
 * For local dev: Returns a placeholder
 * For production: Would proxy from blob storage (not implemented yet)
 */
app.http("images", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "images/{id}",
  handler: async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
    try {
      const id = request.params.id;

      if (!id) {
        return {
          status: 400,
          body: JSON.stringify({ error: "Missing image ID" }),
        };
      }

      // TODO: Implement actual image serving from blob storage
      // For now, return a simple placeholder for local dev

      // Return a simple 1x1 transparent PNG as placeholder
      const placeholderPng = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        "base64"
      );

      return {
        status: 200,
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=3600",
        },
        body: placeholderPng,
      };
    } catch (error) {
      context.error(`[images] Error serving image:`, error);
      return {
        status: 500,
        body: JSON.stringify({ error: "Failed to serve image" }),
      };
    }
  },
});
