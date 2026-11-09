import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { defaultReadableContainers, deleteBlobFromStorageUrl, isCatalogStorageUrl } from "../lib/blob-storage";
import { withAdmin } from "../lib/auth";
import { query, transaction } from "../lib/db";
import { internalServerError } from "../lib/errors";
import { withCors } from "../lib/http";
import { runSourceImageRemovalBatch, type SourceImageRemovalOptions } from "../lib/source-image-removal";
import { trackEvent } from "../lib/telemetry";

const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 500;

/**
 * Body of POST /api/images-admin/source-images/remove. The source is named with `sources`
 * (exactly one name, the key the admin Backfills tab sends from its "Data sources" input).
 */
export function parseSourceImageRemovalBody(raw: unknown): SourceImageRemovalOptions | string {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const sources = body.sources;
  if (
    !Array.isArray(sources) ||
    sources.length !== 1 ||
    typeof sources[0] !== "string" ||
    sources[0].trim().length === 0
  ) {
    return "sources must hold exactly one data source name";
  }
  const afterImageId = body.afterImageId ?? 0;
  const limit = body.limit ?? DEFAULT_BATCH_SIZE;
  const dryRun = body.dryRun ?? true;
  if (typeof afterImageId !== "number" || !Number.isInteger(afterImageId) || afterImageId < 0) {
    return "afterImageId must be a non-negative integer";
  }
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_BATCH_SIZE) {
    return `limit must be an integer between 1 and ${MAX_BATCH_SIZE}`;
  }
  if (typeof dryRun !== "boolean") {
    return "dryRun must be a boolean";
  }
  return { sourceName: sources[0].trim(), afterImageId, limit, dryRun };
}

/**
 * POST /api/images-admin/source-images/remove — remove a disabled source's catalog images (a
 * store asked us to stop using its pictures): unlink their swatches, delete the `image_asset` rows
 * and their blobs + thumbnail variants. Admin-only, dry run unless `"dryRun": false`; 404 for an
 * unknown source, 409 `source_enabled` while the source is enabled. Keyset-paginated by
 * `image_id` (`afterImageId`, `limit` default 100, max 500); the caller repeats with
 * `nextAfterImageId` until it is null (`scripts/remove-source-images.cjs`); a batch stops after
 * about 45 s (`SOURCE_IMAGE_REMOVAL_TIME_BUDGET_MS`) with a cursor to continue, and answers 409 if
 * the source is re-enabled mid-batch. See
 * `lib/source-image-removal.ts` for what is kept.
 */
export async function removeSourceImages(
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
  const parsed = parseSourceImageRemovalBody(rawBody);
  if (typeof parsed === "string") {
    return { status: 400, jsonBody: { error: parsed } };
  }

  const allowedContainers = defaultReadableContainers();
  let outcome: Awaited<ReturnType<typeof runSourceImageRemovalBatch>>;
  try {
    outcome = await runSourceImageRemovalBatch(
      {
        query,
        transaction,
        // A source image kept at its vendor URL (no storage at ingest time) has no blob of ours.
        ownsBlob: isCatalogStorageUrl,
        deleteBlob: async (storageUrl) => deleteBlobFromStorageUrl(storageUrl, { allowedContainers }),
      },
      parsed
    );
  } catch (error) {
    return internalServerError(context, error, "Source image removal batch failed", "images-admin.source-images-remove");
  }

  if (outcome.status === "not_found") {
    return { status: 404, jsonBody: { error: "source_not_found", message: `No data source named ${parsed.sourceName}` } };
  }
  if (outcome.status === "source_busy") {
    return {
      status: 409,
      jsonBody: {
        error: "source_busy",
        message: `${parsed.sourceName} has ${outcome.activeJobs} queued or running ingestion job(s); wait for them to finish, then retry`,
        activeJobs: outcome.activeJobs,
      },
    };
  }
  if (outcome.status === "source_enabled") {
    // A mid-batch re-enable still reports the images already removed, the failures (with their
    // blob URLs) and the cursor to resume from once the source is disabled again.
    return {
      status: 409,
      jsonBody: {
        error: "source_enabled",
        message: `Disable ${parsed.sourceName} before removing its images`,
        ...(outcome.result ? { result: outcome.result } : {}),
      },
    };
  }

  const result = outcome.result;
  context.log(
    `[source-images-admin] source=${parsed.sourceName} after=${parsed.afterImageId} dryRun=${parsed.dryRun} scanned=${result.scanned} swatches=${result.swatchesUnlinked} images=${result.imagesDeleted} blobs=${result.blobsDeleted} kept=${result.kept.length} failures=${result.failures.length}`
  );
  trackEvent("source_images.remove_batch", {
    source: parsed.sourceName,
    dryRun: String(parsed.dryRun),
    scanned: String(result.scanned),
    swatchesUnlinked: String(result.swatchesUnlinked),
    imagesDeleted: String(result.imagesDeleted),
    blobsDeleted: String(result.blobsDeleted),
    kept: String(result.kept.length),
    failures: String(result.failures.length),
  });
  return { status: 200, jsonBody: result };
}

app.http("source-images-remove-admin", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "images-admin/source-images/remove",
  handler: withCors(withAdmin(async (request, context) => removeSourceImages(request, context))),
});
