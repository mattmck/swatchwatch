import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { isCatalogStorageUrl, readBlobFromStorageUrl } from "../lib/blob-storage";
import { withAdmin } from "../lib/auth";
import { query, transaction } from "../lib/db";
import { runGalleryDedupeBatch, type GalleryDedupeOptions } from "../lib/gallery-dedupe";
import { withCors } from "../lib/http";
import { trackEvent } from "../lib/telemetry";

const DEFAULT_BATCH_SIZE = 25;
const MAX_BATCH_SIZE = 100;
const MAX_SHADE_IDS = 500;

export function parseGalleryDedupeBody(raw: unknown): GalleryDedupeOptions | string {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const afterShadeId = body.afterShadeId ?? 0;
  const limit = body.limit ?? DEFAULT_BATCH_SIZE;
  const dryRun = body.dryRun ?? true;
  const storeFingerprints = body.storeFingerprints ?? true;
  if (typeof afterShadeId !== "number" || !Number.isInteger(afterShadeId) || afterShadeId < 0) {
    return "afterShadeId must be a non-negative integer";
  }
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_BATCH_SIZE) {
    return `limit must be an integer between 1 and ${MAX_BATCH_SIZE}`;
  }
  if (typeof dryRun !== "boolean") {
    return "dryRun must be a boolean";
  }
  if (typeof storeFingerprints !== "boolean") {
    return "storeFingerprints must be a boolean";
  }
  let shadeIds: number[] | undefined;
  if (body.shadeIds !== undefined) {
    if (
      !Array.isArray(body.shadeIds) ||
      body.shadeIds.length === 0 ||
      body.shadeIds.length > MAX_SHADE_IDS ||
      !body.shadeIds.every((id) => typeof id === "number" && Number.isInteger(id) && id > 0)
    ) {
      return `shadeIds must be 1–${MAX_SHADE_IDS} positive integers`;
    }
    shadeIds = body.shadeIds as number[];
  }
  return { afterShadeId, limit, dryRun, storeFingerprints, shadeIds };
}

/**
 * POST /api/images-admin/gallery-dedupe — unlink catalog gallery images that duplicate another
 * image of the same shade (the same vendor picture stored twice under different checksums).
 *
 * Admin-only. Dry run unless the body says `"dryRun": false`. Keyset-paginated over shades with a
 * `source_gallery` swatch (`shade_id > afterShadeId`, `limit` shades, default 25, max 100,
 * optionally only `shadeIds`); the caller repeats with `nextAfterShadeId` until it is null
 * (`scripts/dedupe-gallery-images.cjs` does the loop). See `lib/gallery-dedupe.ts` for the rules.
 * Also the `image_asset` fingerprint backfill: fingerprints computed from blobs are saved where
 * still empty, even in a dry run, unless `"storeFingerprints": false`.
 */
export async function dedupeGalleryImages(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  if (!process.env.AZURE_STORAGE_CONNECTION?.trim()) {
    return { status: 503, jsonBody: { error: "AZURE_STORAGE_CONNECTION is not configured" } };
  }

  let rawBody: unknown = {};
  try {
    const text = await request.text();
    rawBody = text.trim() ? JSON.parse(text) : {};
  } catch {
    return { status: 400, jsonBody: { error: "Request body must be valid JSON" } };
  }
  const parsed = parseGalleryDedupeBody(rawBody);
  if (typeof parsed === "string") {
    return { status: 400, jsonBody: { error: parsed } };
  }

  const result = await runGalleryDedupeBatch(
    {
      query,
      transaction,
      readImage: async (storageUrl) => {
        if (!isCatalogStorageUrl(storageUrl)) {
          throw new Error("not a catalog blob on the configured storage account");
        }
        return (await readBlobFromStorageUrl(storageUrl)).bytes;
      },
    },
    parsed
  );

  context.log(
    `[gallery-dedupe-admin] after=${parsed.afterShadeId} dryRun=${parsed.dryRun} shades=${result.scannedShades} groups=${result.duplicateGroups} removed=${result.swatchesRemoved} unreadable=${result.unreadableImages} fingerprintsStored=${result.fingerprintsStored}`
  );
  trackEvent("gallery_dedupe.batch", {
    dryRun: String(parsed.dryRun),
    scannedShades: String(result.scannedShades),
    duplicateGroups: String(result.duplicateGroups),
    swatchesRemoved: String(result.swatchesRemoved),
    unreadableImages: String(result.unreadableImages),
    fingerprintsStored: String(result.fingerprintsStored),
  });
  return { status: 200, jsonBody: result };
}

app.http("gallery-dedupe-admin", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "images-admin/gallery-dedupe",
  handler: withCors(withAdmin(async (request, context) => dedupeGalleryImages(request, context))),
});
