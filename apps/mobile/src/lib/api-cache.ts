/**
 * Persisted API cache for stale-while-revalidate: a screen shows the last saved response
 * immediately (so the Collection opens instantly, also with a bad connection), then replaces it
 * with the fresh one. Entries are scoped by user id, expire after `MAX_AGE_MS`, and are wiped on
 * sign-out. Only small, first-page style payloads should go here.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  getAllKeys(): Promise<readonly string[]>;
}

export interface CacheEntry<T> {
  data: T;
  /** Epoch ms when it was saved. */
  savedAt: number;
}

const PREFIX = "swatchwatch.cache.v1:";

/** Entries older than this are ignored (and removed on read). */
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function cacheStorageKey(scope: string, key: string): string {
  return `${PREFIX}${scope}:${key}`;
}

export function isExpired(savedAt: number, now: number, maxAgeMs: number = MAX_AGE_MS): boolean {
  return !Number.isFinite(savedAt) || now - savedAt > maxAgeMs || savedAt > now + 60_000;
}

export function createApiCache(store: KeyValueStore, clock: () => number = Date.now) {
  return {
    async read<T>(scope: string, key: string): Promise<CacheEntry<T> | null> {
      const storageKey = cacheStorageKey(scope, key);
      try {
        const raw = await store.getItem(storageKey);
        if (!raw) return null;
        const entry = JSON.parse(raw) as CacheEntry<T>;
        if (!entry || typeof entry.savedAt !== "number" || isExpired(entry.savedAt, clock())) {
          await store.removeItem(storageKey);
          return null;
        }
        return entry;
      } catch {
        return null;
      }
    },

    async write<T>(scope: string, key: string, data: T): Promise<void> {
      try {
        await store.setItem(cacheStorageKey(scope, key), JSON.stringify({ data, savedAt: clock() } satisfies CacheEntry<T>));
      } catch {
        // A full or unavailable store only costs the offline copy.
      }
    },

    /** Remove every cached entry (all users), e.g. on sign-out. */
    async clear(): Promise<void> {
      try {
        const keys = (await store.getAllKeys()).filter((k) => k.startsWith(PREFIX));
        await Promise.all(keys.map((k) => store.removeItem(k)));
      } catch {
        // Nothing to clear.
      }
    },
  };
}

const apiCache = createApiCache({
  getItem: (k) => AsyncStorage.getItem(k),
  setItem: (k, v) => AsyncStorage.setItem(k, v),
  removeItem: (k) => AsyncStorage.removeItem(k),
  getAllKeys: () => AsyncStorage.getAllKeys(),
});

export const readCache = apiCache.read;
export const writeCache = apiCache.write;
export const clearApiCache = apiCache.clear;
