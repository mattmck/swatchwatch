/**
 * Collection stats API (issue #271): `GET /api/stats/collection`.
 *
 * Dashboard aggregates for the caller's own inventory (spend by brand / month per currency,
 * untried %, worn vs waiting, most-worn, cost per wear, totals by status). Every query is scoped
 * to the authenticated user (`withAuth`, `ui.user_id = $1`); see `lib/collection-stats.ts`.
 *
 * Cached per user in Redis for `COLLECTION_STATS_CACHE_TTL_SECONDS` (60s). Every write that
 * changes the inventory or the mani log drops the entry through
 * `invalidatePolishCachesForUser` (`lib/polish-cache.ts`). Browsers and shared proxies get
 * `Cache-Control: private, no-cache`, so a stale copy is never served after an invalidation.
 */
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { CollectionStatsResponse } from "swatchwatch-shared";
import { query } from "../lib/db";
import { withAuth } from "../lib/auth";
import { withCors } from "../lib/http";
import { cacheGetJson, cacheSetJson } from "../lib/cache";
import { internalServerError } from "../lib/errors";
import {
  COLLECTION_STATS_CACHE_TTL_SECONDS,
  collectionStatsCacheKey,
  loadCollectionStats,
} from "../lib/collection-stats";

const STATS_RESPONSE_HEADERS = { "Cache-Control": "private, no-cache" };

export async function getCollectionStats(
  request: HttpRequest,
  context: InvocationContext,
  userId: number
): Promise<HttpResponseInit> {
  context.log(`GET /api/stats/collection (user ${userId})`);
  try {
    const cacheKey = collectionStatsCacheKey(userId);
    const cached = await cacheGetJson<CollectionStatsResponse>(cacheKey);
    if (cached) {
      return { status: 200, headers: STATS_RESPONSE_HEADERS, jsonBody: cached };
    }

    const stats = await loadCollectionStats((text, params) => query(text, params), userId);
    await cacheSetJson(cacheKey, stats, COLLECTION_STATS_CACHE_TTL_SECONDS);
    return { status: 200, headers: STATS_RESPONSE_HEADERS, jsonBody: stats };
  } catch (error) {
    return internalServerError(context, error, "Failed to load collection stats", "stats.collection");
  }
}

app.http("stats-collection", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "stats/collection",
  handler: withCors(withAuth(getCollectionStats)),
});
