import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Polish, PolishListResponse } from "swatchwatch-shared";
import {
  API_CACHE_PREFIX,
  API_CACHE_TTL_MS,
  MAX_DETAIL_ENTRIES,
  MAX_ENTRY_CHARS,
  MAX_LIST_ENTRIES,
  MAX_TOTAL_CHARS,
  bindCacheUser,
  clearCache,
  ownedListCacheQuery,
  readCache,
  readOwnedList,
  readPolishDetail,
  stripPrivateMedia,
  writeOwnedList,
  writePolishDetail,
  type CacheContext,
  type CacheStorage,
} from "./api-cache";
import { DEFAULT_LIST_STATE } from "./polish-list-url";

function memoryStorage(quotaChars = Infinity): CacheStorage & { size: () => number; keys: () => string[] } {
  const items = new Map<string, string>();
  const total = () => [...items.entries()].reduce((sum, [k, v]) => sum + k.length + v.length, 0);
  return {
    get length() {
      return items.size;
    },
    key: (index: number) => [...items.keys()][index] ?? null,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      const previous = items.get(key);
      const next = total() - (previous === undefined ? 0 : key.length + previous.length) + key.length + value.length;
      if (next > quotaChars) throw new Error("QuotaExceededError");
      items.set(key, value);
    },
    removeItem: (key: string) => {
      items.delete(key);
    },
    size: total,
    keys: () => [...items.keys()],
  };
}

const NOW = Date.UTC(2026, 9, 23, 12, 0, 0);

function ctx(storage: CacheStorage, overrides: Partial<CacheContext> = {}): CacheContext {
  return { storage, userKey: "user-a", now: NOW, ...overrides };
}

function polish(id: number, overrides: Partial<Polish> = {}): Polish {
  return {
    id: String(id),
    shadeId: String(id),
    inventoryItemId: `inv-${id}`,
    userId: "1",
    brand: "Cirque Colors",
    name: `Shade number ${id}`,
    color: "Sparkling Rose Quartz Shimmer",
    vendorHex: "#C08081",
    detectedHex: "#BF7F82",
    nameHex: "#C48A8C",
    finish: "shimmer",
    finishes: ["shimmer", "glitter"],
    status: "owned",
    quantity: 1,
    swatchImageUrl: `https://api.example.test/api/images/v2.abcdefghijklmnopqrstuvwxyz0123456789.${id}.sig?w=64`,
    sourceImageUrls: [
      `https://api.example.test/api/images/v2.abcdefghijklmnopqrstuvwxyz0123456789.${id}a.sig`,
      `https://api.example.test/api/images/v2.abcdefghijklmnopqrstuvwxyz0123456789.${id}b.sig`,
    ],
    buyUrl: `https://shop.example.test/products/shade-${id}`,
    notes: "Bought at the Brooklyn pop-up, applies in two coats, great with a matte top coat.",
    tags: ["indie", "shimmer", "pink"],
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-02T00:00:00.000Z",
    ...overrides,
  } as Polish;
}

function page(count: number): PolishListResponse {
  return { polishes: Array.from({ length: count }, (_, i) => polish(i + 1)), total: count, page: 1, pageSize: count };
}

describe("stripPrivateMedia", () => {
  it("drops owner-scoped v3 image urls anywhere in the value and keeps public v2 urls", () => {
    const input = {
      nailImageUrl: "https://api.example.test/api/images/v3.payload.1.2.sig",
      swatchImageUrl: "https://api.example.test/api/images/v2.payload.1.sig",
      nested: { photos: ["/api/images/v3.x.y", "/api/images/v2.keep"] },
    };
    const out = stripPrivateMedia(input);
    assert.deepEqual(out, {
      swatchImageUrl: "https://api.example.test/api/images/v2.payload.1.sig",
      nested: { photos: ["/api/images/v2.keep"] },
    });
    assert.ok(input.nailImageUrl, "the input is not mutated");
  });

  it("never lets a v3 url reach storage", () => {
    const storage = memoryStorage();
    writePolishDetail(ctx(storage), polish(1, { nailImageUrl: "https://api.example.test/api/images/v3.a.b.c.d" }));
    for (const key of storage.keys()) {
      assert.ok(!storage.getItem(key)?.includes("/api/images/v3."), key);
    }
    assert.equal(readPolishDetail(ctx(storage), 1)?.data.nailImageUrl, undefined);
  });
});

describe("ownedListCacheQuery", () => {
  const owned = { ...DEFAULT_LIST_STATE, statuses: ["owned" as const] };

  it("caches only page 1 of the owned-only preset, keyed by the filter set", () => {
    assert.equal(ownedListCacheQuery(owned), "status=owned");
    assert.equal(ownedListCacheQuery({ ...owned, search: "rose" }), "q=rose&status=owned");
    assert.notEqual(ownedListCacheQuery({ ...owned, familyFilter: "pink" }), ownedListCacheQuery(owned));
  });

  it("does not cache other views", () => {
    assert.equal(ownedListCacheQuery({ ...owned, page: 2 }), null);
    assert.equal(ownedListCacheQuery({ ...owned, toneFilter: "warm" }), null);
    assert.equal(ownedListCacheQuery({ ...owned, statuses: ["owned", "wishlist"] }), null);
    assert.equal(ownedListCacheQuery({ ...owned, statuses: ["wishlist"] }), null);
    assert.equal(ownedListCacheQuery(DEFAULT_LIST_STATE), null);
  });
});

describe("owned list cache", () => {
  it("round-trips a page with its save time", () => {
    const storage = memoryStorage();
    assert.equal(writeOwnedList(ctx(storage), "status=owned", page(10)), true);
    const saved = readOwnedList(ctx(storage, { now: NOW + 5000 }), "status=owned");
    assert.equal(saved?.savedAt, NOW);
    assert.equal(saved?.data.polishes.length, 10);
    assert.equal(saved?.data.total, 10);
  });

  it("keeps separate entries per filter set and per user", () => {
    const storage = memoryStorage();
    writeOwnedList(ctx(storage), "status=owned", page(3));
    writeOwnedList(ctx(storage), "q=rose&status=owned", page(1));
    assert.equal(readOwnedList(ctx(storage), "status=owned")?.data.polishes.length, 3);
    assert.equal(readOwnedList(ctx(storage), "q=rose&status=owned")?.data.polishes.length, 1);
    assert.equal(readOwnedList(ctx(storage, { userKey: "user-b" }), "status=owned"), null);
  });

  it("expires after 7 days and removes the entry", () => {
    const storage = memoryStorage();
    writeOwnedList(ctx(storage), "status=owned", page(2));
    assert.ok(readOwnedList(ctx(storage, { now: NOW + API_CACHE_TTL_MS }), "status=owned"));
    assert.equal(readOwnedList(ctx(storage, { now: NOW + API_CACHE_TTL_MS + 1 }), "status=owned"), null);
    assert.equal(storage.keys().length, 0);
  });

  it("ignores entries from another cache version or corrupt JSON", () => {
    const storage = memoryStorage();
    writeOwnedList(ctx(storage), "status=owned", page(2));
    const key = storage.keys()[0];
    storage.setItem(key, JSON.stringify({ v: 999, savedAt: NOW, data: page(2) }));
    assert.equal(readOwnedList(ctx(storage), "status=owned"), null);
    storage.setItem(key, "{not json");
    assert.equal(readOwnedList(ctx(storage), "status=owned"), null);
  });

  it("stays within the per-entry size guard for 500 rows (rows are dropped, the total is kept)", () => {
    const rows = page(500);
    const raw = JSON.stringify(rows).length;
    assert.ok(raw > MAX_ENTRY_CHARS, `500 rows are ${raw} chars, over the ${MAX_ENTRY_CHARS} guard`);

    const storage = memoryStorage();
    assert.equal(writeOwnedList(ctx(storage), "status=owned", rows), true);
    const stored = storage.getItem(storage.keys()[0]) ?? "";
    assert.ok(stored.length <= MAX_ENTRY_CHARS, `stored ${stored.length} chars`);
    const saved = readOwnedList(ctx(storage), "status=owned");
    assert.ok(saved && saved.data.polishes.length > 0 && saved.data.polishes.length < 500);
    assert.equal(saved?.data.total, 500);
    assert.equal(saved?.data.polishes[0].id, "1", "the first rows are the ones kept");
  });

  it("a 100-row page (the largest page size) fits whole", () => {
    const storage = memoryStorage();
    writeOwnedList(ctx(storage), "pageSize=100&status=owned", page(100));
    assert.equal(readOwnedList(ctx(storage), "pageSize=100&status=owned")?.data.polishes.length, 100);
  });

  it("keeps only the newest MAX_LIST_ENTRIES filter sets", () => {
    const storage = memoryStorage();
    for (let i = 0; i < MAX_LIST_ENTRIES + 3; i += 1) {
      writeOwnedList(ctx(storage, { now: NOW + i }), `q=${i}&status=owned`, page(1));
    }
    assert.equal(storage.keys().length, MAX_LIST_ENTRIES);
    assert.equal(readOwnedList(ctx(storage), "q=0&status=owned"), null);
    assert.ok(readOwnedList(ctx(storage), `q=${MAX_LIST_ENTRIES + 2}&status=owned`));
  });
});

describe("polish detail cache", () => {
  it("round-trips a polish by id", () => {
    const storage = memoryStorage();
    writePolishDetail(ctx(storage), polish(42));
    assert.equal(readPolishDetail(ctx(storage), "42")?.data.name, "Shade number 42");
    assert.equal(readPolishDetail(ctx(storage), 43), null);
  });

  it("evicts the oldest details past MAX_DETAIL_ENTRIES", () => {
    const storage = memoryStorage();
    for (let i = 1; i <= MAX_DETAIL_ENTRIES + 5; i += 1) {
      writePolishDetail(ctx(storage, { now: NOW + i }), polish(i));
    }
    assert.equal(storage.keys().length, MAX_DETAIL_ENTRIES);
    assert.equal(readPolishDetail(ctx(storage), 1), null);
    assert.ok(readPolishDetail(ctx(storage), MAX_DETAIL_ENTRIES + 5));
  });

  it("evicts the oldest entries of any kind to stay under the total budget", () => {
    const storage = memoryStorage();
    // Fill with large list entries (just under the per-entry cap each).
    for (let i = 0; i < MAX_LIST_ENTRIES; i += 1) {
      writeOwnedList(ctx(storage, { now: NOW + i }), `q=${i}&status=owned`, page(300));
    }
    writePolishDetail(ctx(storage, { now: NOW + 100 }), polish(1));
    const total = storage.keys().reduce((sum, key) => sum + (storage.getItem(key)?.length ?? 0), 0);
    assert.ok(total <= MAX_TOTAL_CHARS, `total ${total}`);
    assert.ok(readPolishDetail(ctx(storage), 1), "the entry just written survives");
  });

  it("recovers from a full storage by clearing the cache and retrying once", () => {
    const storage = memoryStorage(3_000);
    storage.setItem(`${API_CACHE_PREFIX}v1:user-a:polish:old`, JSON.stringify({ v: 1, savedAt: NOW - 10, data: "x".repeat(1_800) }));
    writePolishDetail(ctx(storage), polish(7, { notes: "short" }));
    assert.ok(readPolishDetail(ctx(storage), 7));
  });

  it("never throws when storage is broken", () => {
    const broken: CacheStorage = {
      length: 0,
      key: () => null,
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    assert.equal(writePolishDetail(ctx(broken), polish(1)), false);
    assert.equal(readPolishDetail(ctx(broken), 1), null);
    assert.equal(readCache(ctx(broken), "anything"), null);
  });
});

describe("sign-out and user switching", () => {
  it("clearCache removes every saved copy and the user marker", () => {
    const storage = memoryStorage();
    storage.setItem("unrelated", "keep");
    bindCacheUser(storage, "user-a");
    writeOwnedList(ctx(storage), "status=owned", page(2));
    writePolishDetail(ctx(storage), polish(1));
    clearCache(storage);
    assert.deepEqual(storage.keys(), ["unrelated"]);
  });

  it("a different user signing in wipes the previous user's copies", () => {
    const storage = memoryStorage();
    bindCacheUser(storage, "user-a");
    writePolishDetail(ctx(storage), polish(1));
    bindCacheUser(storage, "user-a");
    assert.ok(readPolishDetail(ctx(storage), 1), "same user keeps their copies");
    bindCacheUser(storage, "user-b");
    assert.equal(readPolishDetail(ctx(storage), 1), null);
    assert.equal(readPolishDetail(ctx(storage, { userKey: "user-b" }), 1), null);
  });
});
