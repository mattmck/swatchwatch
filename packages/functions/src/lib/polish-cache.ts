import { cacheDeleteByPrefix } from "./cache";

/**
 * Drop the caller's cached polish list pages and the detail entries of `shadeIds`
 * (keys built in `functions/polishes.ts`). Used by every write that changes what
 * `GET /api/polishes*` returns for one user, including the mani log's wear stats.
 */
export async function invalidatePolishCachesForUser(userId: number, shadeIds: number[] = []): Promise<void> {
  await Promise.all([
    cacheDeleteByPrefix(`polishes:list:u:${userId}:`),
    ...shadeIds.map((shadeId) => cacheDeleteByPrefix(`polishes:detail:u:${userId}:id:${shadeId}:`)),
  ]);
}
