import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import pLimit = require("p-limit");
import {
  defaultReadableContainers,
  ensureImageVariants,
  isCatalogStorageUrl,
  readBlobFromStorageUrl,
  storageUrlBlobName,
} from "../lib/blob-storage";
import { withAdmin } from "../lib/auth";
import { query } from "../lib/db";
import { withCors } from "../lib/http";
import { isImageVariantBlobName } from "../lib/image-variants";
import { trackEvent } from "../lib/telemetry";

const DEFAULT_BATCH_SIZE = 25;
const MAX_BATCH_SIZE = 100;
const CONCURRENCY = 4;
const MAX_REPORTED_FAILURES = 20;

export interface ImageVariantBackfillResponse {
  /** `image_asset` rows read in this batch. */
  scanned: number;
  /** Distinct catalog blobs checked (rows sharing a storage URL are checked once). */
  checked: number;
  /** Blobs that already had every variant (their originals were not read). */
  complete: number;
  /** Variant blobs written in this batch. */
  variantsWritten: number;
  /** Rows skipped: not a catalog blob on the configured storage account. */
  skipped: number;
  failures: { imageId: number; error: string }[];
  /** Pass as `afterImageId` for the next batch; null when the scan is finished. */
  nextAfterImageId: number | null;
}

function parseBody(raw: unknown): { afterImageId: number; limit: number } | string {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const afterImageId = body.afterImageId ?? 0;
  const limit = body.limit ?? DEFAULT_BATCH_SIZE;
  if (typeof afterImageId !== "number" || !Number.isInteger(afterImageId) || afterImageId < 0) {
    return "afterImageId must be a non-negative integer";
  }
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_BATCH_SIZE) {
    return `limit must be an integer between 1 and ${MAX_BATCH_SIZE}`;
  }
  return { afterImageId, limit };
}

/**
 * POST /api/images-admin/variants/backfill — generate the pre-generated thumbnails
 * (`IMAGE_VARIANT_SIZES`, lib/image-variants) for catalog images stored before they existed.
 *
 * Admin-only. Keyset-paginated over `image_asset` (`owner_type = 'source'`, `image_id > afterImageId`,
 * `limit` rows, default 25, max 100): the caller repeats with `nextAfterImageId` until it is null
 * (`scripts/backfill-image-variants.cjs` does the loop). Idempotent: existing variants are skipped
 * without reading the original, so a re-run only fills gaps.
 */
export async function backfillImageVariants(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  const connectionString = process.env.AZURE_STORAGE_CONNECTION?.trim();
  if (!connectionString) {
    return { status: 503, jsonBody: { error: "AZURE_STORAGE_CONNECTION is not configured" } };
  }

  let rawBody: unknown = {};
  try {
    const text = await request.text();
    rawBody = text.trim() ? JSON.parse(text) : {};
  } catch {
    return { status: 400, jsonBody: { error: "Request body must be valid JSON" } };
  }
  const parsed = parseBody(rawBody);
  if (typeof parsed === "string") {
    return { status: 400, jsonBody: { error: parsed } };
  }

  const rows = await query<{ image_id: string | number; storage_url: string }>(
    `SELECT image_id, storage_url
       FROM image_asset
      WHERE owner_type = 'source'
        AND image_id > $1
      ORDER BY image_id
      LIMIT $2`,
    [parsed.afterImageId, parsed.limit]
  );

  const response: ImageVariantBackfillResponse = {
    scanned: rows.rows.length,
    checked: 0,
    complete: 0,
    variantsWritten: 0,
    skipped: 0,
    failures: [],
    nextAfterImageId: null,
  };

  const byUrl = new Map<string, number>();
  for (const row of rows.rows) {
    const url = row.storage_url;
    const blobName = storageUrlBlobName(url);
    if (!isCatalogStorageUrl(url) || !blobName || isImageVariantBlobName(blobName)) {
      response.skipped += 1;
      continue;
    }
    if (!byUrl.has(url)) byUrl.set(url, Number(row.image_id));
  }

  // isCatalogStorageUrl above: every remaining URL is in the catalog container.
  const [containerName] = defaultReadableContainers();
  const limit = pLimit(CONCURRENCY);
  await Promise.all(
    [...byUrl].map(([storageUrl, imageId]) =>
      limit(async () => {
        response.checked += 1;
        try {
          const result = await ensureImageVariants({
            connectionString,
            containerName,
            blobName: storageUrlBlobName(storageUrl),
            // Transient blob read failures (`fetch failed`) are retried rather than reported.
            bytes: async () => (await readBlobFromStorageUrl(storageUrl, { retry: true })).bytes,
          });
          response.variantsWritten += result.written.length;
          if (result.written.length === 0 && result.failed.length === 0) response.complete += 1;
          if (result.failed.length > 0) {
            response.failures.push({ imageId, error: `failed sizes: ${result.failed.join(", ")}` });
          }
        } catch (error) {
          response.failures.push({ imageId, error: error instanceof Error ? error.message : String(error) });
        }
      })
    )
  );

  const failureCount = response.failures.length;
  response.failures = response.failures.sort((a, b) => a.imageId - b.imageId).slice(0, MAX_REPORTED_FAILURES);
  if (rows.rows.length === parsed.limit) {
    response.nextAfterImageId = Number(rows.rows[rows.rows.length - 1].image_id);
  }

  context.log(
    `[image-variants-admin] backfill after=${parsed.afterImageId} scanned=${response.scanned} written=${response.variantsWritten} failed=${failureCount}`
  );
  trackEvent("image_variants.backfill_batch", {
    scanned: String(response.scanned),
    variantsWritten: String(response.variantsWritten),
    failed: String(failureCount),
  });
  return { status: 200, jsonBody: response };
}

app.http("image-variants-admin-backfill", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "images-admin/variants/backfill",
  handler: withCors(withAdmin(async (request, context) => backfillImageVariants(request, context))),
});
