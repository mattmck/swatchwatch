import { cacheDelete, cacheDeleteByPrefix } from "./cache";
import { COLLECTION_STATS_CACHE_PREFIX, collectionStatsCacheKey } from "./collection-stats";

/**
 * Drop the caller's cached polish list pages, the detail entries of `shadeIds` (keys built in
 * `functions/polishes.ts`) and the caller's collection stats (`functions/stats.ts`). Used by
 * every write that changes what `GET /api/polishes*` or `GET /api/stats/collection` returns for
 * one user, including the mani log's wear stats.
 */
export async function invalidatePolishCachesForUser(userId: number, shadeIds: number[] = []): Promise<void> {
  await Promise.all([
    cacheDeleteByPrefix(`polishes:list:u:${userId}:`),
    ...shadeIds.map((shadeId) => cacheDeleteByPrefix(`polishes:detail:u:${userId}:id:${shadeId}:`)),
    cacheDelete(collectionStatsCacheKey(userId)),
  ]);
}

/** Drop every user's cached collection stats (a shared shade/brand changed, e.g. its hex). */
export async function invalidateAllCollectionStats(): Promise<void> {
  await cacheDeleteByPrefix(COLLECTION_STATS_CACHE_PREFIX);
}
