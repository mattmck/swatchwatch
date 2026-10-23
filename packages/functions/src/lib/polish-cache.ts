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

/**
 * Drop the catalog-wide caches whose responses show shared shade data (finishes, category, buy
 * price): catalog search, every user's polish list and detail pages, every user's collection
 * stats, and the catalog detail entries of `shadeIds`. For admin writes that change many shades.
 */
export async function invalidateCatalogWideCaches(shadeIds: readonly number[] = []): Promise<void> {
  await Promise.all([
    cacheDeleteByPrefix("catalog:search:"),
    cacheDeleteByPrefix("polishes:list:u:"),
    cacheDeleteByPrefix("polishes:detail:u:"),
    invalidateAllCollectionStats(),
    ...shadeIds.map((shadeId) => cacheDelete(`catalog:shade:id:${shadeId}`)),
  ]);
}
