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
/**
 * Wall-clock budget per batch. Images still missing variants cost a blob read, four renders and four
 * writes each, so a full 100-row batch can outlast the front end's 230s HTTP limit (the caller then
 * never gets its cursor). Once the budget is spent no new image is started and the batch ends early.
 */
const BATCH_TIME_BUDGET_MS = 45_000;

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
  /**
   * Pass as `afterImageId` for the next batch; null when the scan is finished. A batch that ran out
   * of time returns the last row it finished, so the next batch picks up the rest.
   */
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
 * without reading the original, so a re-run only fills gaps. Each batch stops starting new images
 * after `BATCH_TIME_BUDGET_MS` and then reports fewer rows than `limit` with a cursor to continue.
 */
export async function backfillImageVariants(
  request: HttpRequest,
  context: InvocationContext,
  options: { timeBudgetMs?: number; now?: () => number } = {}
): Promise<HttpResponseInit> {
  const now = options.now ?? Date.now;
  const timeBudgetMs = options.timeBudgetMs ?? BATCH_TIME_BUDGET_MS;
  const startedAt = now();
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

  // Distinct catalog URLs in image_id order, each with the row index where it first appears.
  const skippedRows: boolean[] = [];
  const byUrl = new Map<string, { imageId: number; rowIndex: number }>();
  rows.rows.forEach((row, rowIndex) => {
    const url = row.storage_url;
    const blobName = storageUrlBlobName(url);
    skippedRows.push(!isCatalogStorageUrl(url) || !blobName || isImageVariantBlobName(blobName));
    if (!skippedRows[rowIndex] && !byUrl.has(url)) byUrl.set(url, { imageId: Number(row.image_id), rowIndex });
  });

  // isCatalogStorageUrl above: every remaining URL is in the catalog container.
  const [containerName] = defaultReadableContainers();
  const limit = pLimit(CONCURRENCY);
  // Images start in row order, so once the budget is spent the unstarted ones are a suffix of the
  // batch; the first of them is where the next batch resumes. The first image always runs.
  let started = 0;
  let deferredFromRow = rows.rows.length;
  await Promise.all(
    [...byUrl].map(([storageUrl, { imageId, rowIndex }]) =>
      limit(async () => {
        if (started > 0 && now() - startedAt >= timeBudgetMs) {
          deferredFromRow = Math.min(deferredFromRow, rowIndex);
          return;
        }
        started += 1;
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
  const processedRows = deferredFromRow;
  response.scanned = processedRows;
  response.skipped = skippedRows.slice(0, processedRows).filter(Boolean).length;
  if (processedRows < rows.rows.length || rows.rows.length === parsed.limit) {
    response.nextAfterImageId = Number(rows.rows[processedRows - 1].image_id);
  }

  context.log(
    `[image-variants-admin] backfill after=${parsed.afterImageId} scanned=${response.scanned} written=${response.variantsWritten} failed=${failureCount}` +
      (processedRows < rows.rows.length ? ` stopped early after ${now() - startedAt}ms (time budget)` : "")
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
