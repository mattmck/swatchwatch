import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { withAdmin } from "../lib/auth";
import { parseBarcodeBackfillBody, runBarcodeBackfillBatch } from "../lib/barcode-backfill";
import { query, transaction } from "../lib/db";
import { internalServerError } from "../lib/errors";
import { withCors } from "../lib/http";
import { trackEvent } from "../lib/telemetry";

/**
 * POST /api/barcodes-admin/backfill — build catalog `barcode` rows from stored connector
 * products (`external_product` GTIN + variant barcodes) through `shade_source_product`.
 *
 * Admin-only. Dry run unless the body says `"dryRun": false` (a dry run executes the same
 * statements and rolls them back, so its report is exact). Keyset-paginated: `limit`
 * products (default 200, max 1000) after `afterExternalProductId`; repeat with
 * `nextAfterExternalProductId` until it is null (`scripts/backfill-barcodes.cjs` loops).
 * See `lib/barcode-backfill.ts` for the rules (first shade wins, ambiguous products skipped).
 */
export async function backfillBarcodes(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  let rawBody: unknown = {};
  try {
    const text = await request.text();
    rawBody = text.trim() ? JSON.parse(text) : {};
  } catch {
    return { status: 400, jsonBody: { error: "Request body must be valid JSON" } };
  }
  const parsed = parseBarcodeBackfillBody(rawBody);
  if (typeof parsed === "string") {
    return { status: 400, jsonBody: { error: parsed } };
  }

  try {
    const report = await runBarcodeBackfillBatch({ query, transaction }, parsed);
    context.log(
      `[barcodes-admin] after=${parsed.afterExternalProductId} dryRun=${parsed.dryRun} products=${report.scannedProducts} gtins=${report.gtinsFound} inserted=${report.inserted} conflicts=${report.conflicts.length} ambiguous=${report.ambiguousProducts.length}`
    );
    trackEvent("barcode_backfill.batch", {
      dryRun: String(parsed.dryRun),
      scannedProducts: String(report.scannedProducts),
      gtinsFound: String(report.gtinsFound),
      inserted: String(report.inserted),
      shadesGainingBarcode: String(report.shadesGainingBarcode),
      conflicts: String(report.conflicts.length),
    });
    return { status: 200, jsonBody: report };
  } catch (error) {
    return internalServerError(context, error, "Barcode backfill batch failed", "barcodes-admin.backfill");
  }
}

app.http("barcodes-admin-backfill", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "barcodes-admin/backfill",
  handler: withCors(withAdmin(async (request, context) => backfillBarcodes(request, context))),
});
