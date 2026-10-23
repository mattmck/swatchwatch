/**
 * Rapid Add's remembered "going through this brand" hints, persisted per user in the API cache
 * (so sign-out wipes them with `clearApiCache`). Reads never fail: a missing, expired or
 * corrupt entry is the empty hints.
 */
import { parseStickyHints, type StickyHints } from "swatchwatch-shared";
import { readCache, writeCache } from "@/lib/api-cache";

export const STICKY_HINTS_CACHE_KEY = "rapid-add.hints";

type Cache = {
  read<T>(scope: string, key: string): Promise<{ data: T } | null>;
  write<T>(scope: string, key: string, data: T): Promise<void>;
};

/** Store-injectable form (tests pass an in-memory `createApiCache`). */
export function createStickyHintsCache(cache: Cache) {
  return {
    async read(scope: string): Promise<StickyHints> {
      return parseStickyHints((await cache.read<unknown>(scope, STICKY_HINTS_CACHE_KEY))?.data);
    },
    write(scope: string, hints: StickyHints): Promise<void> {
      return cache.write(scope, STICKY_HINTS_CACHE_KEY, hints);
    },
  };
}

const stickyHintsCache = createStickyHintsCache({ read: readCache, write: writeCache });

export const readStickyHintsCache = stickyHintsCache.read;
export const writeStickyHintsCache = stickyHintsCache.write;
