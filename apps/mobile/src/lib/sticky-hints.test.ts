import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EMPTY_STICKY_HINTS, type StickyHints } from "swatchwatch-shared";
import { cacheStorageKey, createApiCache, type KeyValueStore } from "./api-cache";
import { createStickyHintsCache, STICKY_HINTS_CACHE_KEY } from "./sticky-hints";

function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: async (k) => data.get(k) ?? null,
    setItem: async (k, v) => void data.set(k, v),
    removeItem: async (k) => void data.delete(k),
    getAllKeys: async () => [...data.keys()],
  };
}

const hints: StickyHints = { brand: "Loud", brandCanonical: "Loud Lacquer", brandId: "7", finish: "creme", collection: null };

describe("sticky hints cache", () => {
  it("round-trips per user scope under the cache key", async () => {
    const store = memoryStore();
    const sticky = createStickyHintsCache(createApiCache(store));
    await sticky.write("1", hints);
    assert.ok(store.data.has(cacheStorageKey("1", STICKY_HINTS_CACHE_KEY)));
    assert.deepEqual(await sticky.read("1"), hints);
    assert.deepEqual(await sticky.read("2"), EMPTY_STICKY_HINTS);
  });

  it("gives empty hints for a corrupt entry", async () => {
    const store = memoryStore();
    const sticky = createStickyHintsCache(createApiCache(store));
    store.data.set(cacheStorageKey("1", STICKY_HINTS_CACHE_KEY), "{not json");
    assert.deepEqual(await sticky.read("1"), EMPTY_STICKY_HINTS);
    store.data.set(cacheStorageKey("1", STICKY_HINTS_CACHE_KEY), JSON.stringify({ data: 42, savedAt: Date.now() }));
    assert.deepEqual(await sticky.read("1"), EMPTY_STICKY_HINTS);
  });
});
