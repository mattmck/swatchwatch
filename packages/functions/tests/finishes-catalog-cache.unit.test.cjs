const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// ---------------------------------------------------------------------------
// Fake ../lib/db whose finish-catalog query can be held open, to race a load against a reset
// ---------------------------------------------------------------------------

const pendingQueries = [];
const dbPath = path.resolve(__dirname, "../dist/lib/db.js");
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: {
    query: () => new Promise((resolve) => pendingQueries.push(resolve)),
    transaction: async () => {
      throw new Error("not used");
    },
  },
};

const { loadFinishCatalog, resetFinishAliasCache } = require("../dist/lib/finishes");

const typeRows = (...names) => ({
  rows: names.map((name) => ({ kind: "type", sourceValue: name, normalizedFinishName: name })),
});

describe("loadFinishCatalog cache", () => {
  it("does not let a load that started before a reset repopulate the cache", async () => {
    resetFinishAliasCache();

    // 1. A load starts and reads the old rows (held open).
    const staleLoad = loadFinishCatalog();
    assert.equal(pendingQueries.length, 1);

    // 2. An admin edit resets the cache while that load is in flight.
    resetFinishAliasCache();

    // 3. The old load finishes with stale data.
    pendingQueries.shift()(typeRows("creme"));
    await staleLoad;

    // The next caller must query again and see the edit, not the stale cached catalog.
    const freshLoad = loadFinishCatalog();
    assert.equal(pendingQueries.length, 1, "a fresh query must be issued after the reset");
    pendingQueries.shift()(typeRows("creme", "glitter"));
    const catalog = await freshLoad;
    assert.ok(catalog.validNames.has("glitter"));
  });
});
