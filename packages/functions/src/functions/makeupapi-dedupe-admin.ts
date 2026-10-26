import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { withAdmin } from "../lib/auth";
import { query, transaction } from "../lib/db";
import { internalServerError } from "../lib/errors";
import { withCors } from "../lib/http";
import { parseMakeupApiDedupeBody, runMakeupApiDedupeBatch } from "../lib/makeupapi-dedupe";
import { invalidateCatalogWideCaches } from "../lib/polish-cache";
import { trackEvent } from "../lib/telemetry";

/**
 * POST /api/shades-admin/makeupapi-dedupe/backfill — merge the duplicate shades the MakeupAPI
 * connector created (copies inside MakeupAPI, and MakeupAPI copies of a brand-store shade) and
 * delete the MakeupAPI-only shades nothing references.
 *
 * Admin-only. Dry run unless the body says `"dryRun": false` (a dry run executes the same
 * statements and rolls them back, so its report is exact). Keyset-paginated: `limit` brands
 * (default 10, max 100) after `afterBrandId`; repeat with `nextAfterBrandId` until it is null
 * (`scripts/dedupe-makeupapi-shades.cjs` loops). Rules in `lib/makeupapi-dedupe.ts`.
 */
export async function backfillMakeupApiDedupe(
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
  const parsed = parseMakeupApiDedupeBody(rawBody);
  if (typeof parsed === "string") {
    return { status: 400, jsonBody: { error: parsed } };
  }

  try {
    const { changedShadeIds, ...report } = await runMakeupApiDedupeBatch(
      { query, transaction },
      { ...parsed, adminUserId }
    );
    if (changedShadeIds.length > 0) {
      await invalidateCatalogWideCaches(changedShadeIds);
    }
    context.log(
      `[makeupapi-dedupe] after=${parsed.afterBrandId} dryRun=${parsed.dryRun} brands=${report.scannedBrands} shades=${report.makeupApiShades} merged=${report.merged} deleted=${report.deleted} kept=${report.keptShades.length} skipped=${report.skippedGroups.length}`
    );
    trackEvent("makeupapi_dedupe.batch", {
      dryRun: String(parsed.dryRun),
      scannedBrands: String(report.scannedBrands),
      merged: String(report.merged),
      deleted: String(report.deleted),
      kept: String(report.keptShades.length),
    });
    return { status: 200, jsonBody: report };
  } catch (error) {
    const pgError = error as { code?: string; constraint?: string } | null;
    if (pgError?.code === "23514" && pgError.constraint === "admin_audit_event_action_check") {
      return { status: 503, jsonBody: { error: "The MakeupAPI cleanup migration is not applied yet" } };
    }
    return internalServerError(context, error, "MakeupAPI dedupe batch failed", "shades-admin.makeupapi-dedupe");
  }
}

app.http("shades-admin-makeupapi-dedupe-backfill", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "shades-admin/makeupapi-dedupe/backfill",
  handler: withCors(withAdmin(backfillMakeupApiDedupe)),
});
