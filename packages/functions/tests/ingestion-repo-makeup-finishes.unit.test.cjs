const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// ---------------------------------------------------------------------------
// Fake ../lib/db: a finish catalog plus an existing shade whose finishes hold a legacy alias
// ---------------------------------------------------------------------------

const shadeUpdates = [];

function fakeRows(sql, params) {
  if (sql.includes("FROM finish_normalization")) {
    return [
      { kind: "type", sourceValue: "holographic", normalizedFinishName: "holographic" },
      { kind: "type", sourceValue: "creme", normalizedFinishName: "creme" },
      { kind: "alias", sourceValue: "holo", normalizedFinishName: "holographic" },
    ];
  }
  if (sql.includes("FROM brand")) return [{ brandId: 1 }];
  if (sql.includes('SELECT shade_id AS "shadeId", finishes')) {
    return [{ shadeId: 7, finishes: ["Holo"] }];
  }
  if (sql.includes("UPDATE shade SET") && sql.includes("color_name = COALESCE($2, color_name)")) {
    // Apply the statement's finishes expression to the stored ["Holo"], the way Postgres would.
    const stored = ["Holo"];
    const incoming = params[3];
    let finishes;
    if (sql.includes("unnest(finishes || $4")) {
      finishes = incoming.length === 0 ? stored : [...new Set([...stored, ...incoming])];
    } else if (sql.includes("COALESCE($4::text[], finishes)")) {
      finishes = incoming ?? stored;
    } else {
      throw new Error("unrecognised finishes expression in UPDATE shade");
    }
    shadeUpdates.push(finishes);
    return [];
  }
  if (sql.includes("RETURNING")) return [{ inventoryItemId: 1, shadeId: 7, brandId: 1 }];
  return [];
}

const dbPath = path.resolve(__dirname, "../dist/lib/db.js");
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: {
    query: async (sql, params) => ({ rows: fakeRows(sql, params), rowCount: 0 }),
    transaction: async (cb) =>
      cb({ query: async (sql, params) => ({ rows: fakeRows(sql, params), rowCount: 0 }) }),
  },
};

const { materializeMakeupApiRecords } = require("../dist/lib/ingestion-repo");

describe("materializeMakeupApiRecords finish merge", () => {
  it("canonicalizes existing alias finishes before merging tag finishes", async () => {
    await materializeMakeupApiRecords(1, [
      {
        externalId: "mk-1",
        raw: {},
        normalized: {
          brand: "Example",
          name: "Prism",
          colorVariants: [{ name: "Prism", hex: "#aabbcc" }],
          tags: ["holographic"],
        },
      },
    ]);

    assert.equal(shadeUpdates.length, 1);
    // "Holo" (stored) and "holographic" (tag) resolve to the same finish: one entry, not two.
    assert.deepEqual(shadeUpdates[0], ["holographic"]);
  });
});
