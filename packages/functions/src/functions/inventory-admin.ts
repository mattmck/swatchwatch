import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { withAdmin } from "../lib/auth";
import { query, transaction } from "../lib/db";
import { internalServerError } from "../lib/errors";
import { withCors } from "../lib/http";
import {
  parseImportedWishlistCleanupBody,
  runImportedWishlistCleanupBatch,
} from "../lib/imported-wishlist-cleanup";
import { invalidatePolishCachesForUser } from "../lib/polish-cache";
import { trackEvent } from "../lib/telemetry";

/**
 * POST /api/inventory-admin/imported-wishlist/backfill — remove the untouched wishlist rows that
 * ingestion used to add for the admin who ran each job (rule in `lib/imported-wishlist-cleanup.ts`).
 *
 * Admin-only. Dry run unless the body says `"dryRun": false`. Keyset-paginated: `limit` rows
 * (default 500, max 2000) after `afterInventoryItemId`; repeat with `nextAfterInventoryItemId`
 * until it is null (the admin Backfills tab loops).
 */
export async function cleanupImportedWishlist(
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
  const parsed = parseImportedWishlistCleanupBody(rawBody);
  if (typeof parsed === "string") {
    return { status: 400, jsonBody: { error: parsed } };
  }

  try {
    const { report, affected } = await runImportedWishlistCleanupBatch({ query, transaction }, parsed);
    await Promise.all([...affected].map(([userId, shadeIds]) => invalidatePolishCachesForUser(userId, shadeIds)));
    context.log(
      `[inventory-admin] imported-wishlist after=${parsed.afterInventoryItemId} dryRun=${parsed.dryRun} scanned=${report.scanned} removed=${report.removed}`
    );
    trackEvent("imported_wishlist_cleanup.batch", {
      dryRun: String(parsed.dryRun),
      scanned: String(report.scanned),
      removed: String(report.removed),
      users: String(Object.keys(report.byUser).length),
    });
    return { status: 200, jsonBody: report };
  } catch (error) {
    return internalServerError(
      context,
      error,
      "Imported wishlist cleanup batch failed",
      "inventory-admin.imported-wishlist"
    );
  }
}

app.http("inventory-admin-imported-wishlist-backfill", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "inventory-admin/imported-wishlist/backfill",
  handler: withCors(withAdmin(async (request, context) => cleanupImportedWishlist(request, context))),
});
