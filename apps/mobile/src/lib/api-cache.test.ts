import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cacheStorageKey, createApiCache, isExpired, MAX_AGE_MS, type KeyValueStore } from "./api-cache";

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

describe("api cache", () => {
  it("round-trips per user scope", async () => {
    let now = 1_000;
    const cache = createApiCache(memoryStore(), () => now);
    await cache.write("1", "polishes", { total: 3 });
    assert.deepEqual((await cache.read<{ total: number }>("1", "polishes"))?.data, { total: 3 });
    assert.equal(await cache.read("2", "polishes"), null);
    now = 5_000;
    assert.equal((await cache.read("1", "polishes"))?.savedAt, 1_000);
  });

  it("drops expired and corrupt entries", async () => {
    const store = memoryStore();
    let now = 0;
    const cache = createApiCache(store, () => now);
    await cache.write("1", "k", 1);
    now = MAX_AGE_MS + 1;
    assert.equal(await cache.read("1", "k"), null);
    assert.equal(store.data.size, 0);
    store.data.set(cacheStorageKey("1", "bad"), "{not json");
    assert.equal(await cache.read("1", "bad"), null);
  });

  it("clear removes only cache entries", async () => {
    const store = memoryStore();
    const cache = createApiCache(store);
    await cache.write("1", "a", 1);
    store.data.set("swatchwatch.auth.v1", "keep");
    await cache.clear();
    assert.deepEqual([...store.data.keys()], ["swatchwatch.auth.v1"]);
  });

  it("treats a far-future timestamp as expired", () => {
    assert.equal(isExpired(10_000_000, 1_000), true);
    assert.equal(isExpired(1_000, 2_000), false);
  });
});
