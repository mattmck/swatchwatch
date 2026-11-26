import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { withAdmin } from "../lib/auth";
import { parseBrandStoreRejectedBody, runBrandStoreRejectedBatch } from "../lib/brand-store-rejected";
import { query, transaction } from "../lib/db";
import { internalServerError } from "../lib/errors";
import { withCors } from "../lib/http";
import { invalidateCatalogWideCaches } from "../lib/polish-cache";
import { trackEvent } from "../lib/telemetry";

/**
 * POST /api/shades-admin/brand-store-rejected/backfill — retire (`status = 'excluded'`) the active
 * shades whose every listing is a brand store product that store's current gate rejects (gel and
 * LED lines while `includeGel` is off, another vendor's items). Held, user, approved and
 * admin-edited shades are kept and listed.
 *
 * Admin-only. Dry run unless the body says `"dryRun": false`. Body: `{ afterShadeId?: number = 0,
 * limit?: 1–1000 = 200, dryRun?: boolean = true, sources?: string[] }`; repeat with
 * `nextAfterShadeId` until it is null (`scripts/backfill-brand-store-rejected.cjs` loops). Rules in
 * `lib/brand-store-rejected.ts`.
 */
export async function backfillBrandStoreRejected(
  request: HttpRequest,
  context: InvocationContext,
  adminUserId: number
): Promise<HttpResponseInit> {
  let rawBody: unknown = {};
  try {
    const text = await request.text();
    rawBody = text.trim() ? JSON.parse(text) : {};
  } catch {
    return { status: 400, jsonBody: { error: "Request body must be valid JSON" } };
  }
  const parsed = parseBrandStoreRejectedBody(rawBody);
  if (typeof parsed === "string") {
    return { status: 400, jsonBody: { error: parsed } };
  }

  try {
    const { changedShadeIds, ...report } = await runBrandStoreRejectedBatch({ query, transaction }, { ...parsed, adminUserId });
    if (changedShadeIds.length > 0) {
      await invalidateCatalogWideCaches(changedShadeIds);
    }
    context.log(
      `[brand-store-rejected] after=${parsed.afterShadeId} dryRun=${parsed.dryRun} scanned=${report.scannedShades} retired=${report.retired} held=${report.held.length} protected=${report.protectedShades.length} partial=${report.partial.length} unsupported=${report.unsupported.length}`
    );
    trackEvent("brand_store_rejected.batch", {
      dryRun: String(parsed.dryRun),
      scannedShades: String(report.scannedShades),
      retired: String(report.retired),
      held: String(report.held.length),
    });
    return { status: 200, jsonBody: report };
  } catch (error) {
    return internalServerError(context, error, "Brand store rejected-products batch failed", "shades-admin.brand-store-rejected");
  }
}

app.http("shades-admin-brand-store-rejected-backfill", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "shades-admin/brand-store-rejected/backfill",
  handler: withCors(withAdmin(backfillBrandStoreRejected)),
});
