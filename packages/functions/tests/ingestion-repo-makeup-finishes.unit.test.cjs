const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// ---------------------------------------------------------------------------
// Fake ../lib/db: a finish catalog, one brand and a configurable set of existing shades.
// ---------------------------------------------------------------------------

let shadeUpdates;
let inserts;
let links;
let statements;
/** Existing shades: { shadeId, name, mergedInto, aliases } */
let existing;

function fakeRows(sql, params) {
  statements.push(sql);
  if (sql.includes("FROM finish_normalization")) {
    return [
      { kind: "type", sourceValue: "holographic", normalizedFinishName: "holographic" },
      { kind: "type", sourceValue: "creme", normalizedFinishName: "creme" },
      { kind: "alias", sourceValue: "holo", normalizedFinishName: "holographic" },
    ];
  }
  if (sql.includes("FROM brand")) return [{ brandId: 1 }];
  const asRow = (s) => ({ shadeId: String(s.shadeId), mergedIntoShadeId: s.mergedInto === null ? null : String(s.mergedInto) });
  if (sql.includes("FROM shade_alias sa") && sql.includes("regexp_replace")) {
    // The SQL key must use the shared pattern; the fake compares with the TypeScript key.
    assert.equal(params[2], MAKEUPAPI_CODE_SUFFIX_PATTERN);
    const key = params[1];
    return existing
      .filter((s) => makeupApiNameKey(s.name) === key || (s.aliases ?? []).some((a) => makeupApiNameKey(a) === key))
      .map(asRow);
  }
  if (sql.includes('merged_into_shade_id::text AS "mergedIntoShadeId"') && sql.includes("WHERE shade_id = $1")) {
    return existing.filter((s) => s.shadeId === Number(params[0])).map(asRow);
  }
  if (sql.includes("product_category = $2") && sql.includes("shade_id = ANY($1::bigint[])")) {
    const ids = params[0].map(Number);
    return existing
      .filter((s) => ids.includes(s.shadeId) && s.mergedInto === null && (s.category ?? "color") === params[1])
      .map((s) => ({ shadeId: String(s.shadeId) }));
  }
  if (sql.includes("INSERT INTO shade (")) {
    inserts.push(params[1]);
    return [{ shadeId: 900 + inserts.length }];
  }
  if (sql.includes("INSERT INTO shade_source_product")) {
    links.push({ shadeId: Number(params[0]), externalId: params[2] });
    return [];
  }
  if (sql.includes("UPDATE shade SET") && sql.includes("color_name = COALESCE($2, color_name)")) {
    assert.ok(sql.includes("COALESCE($4::text[], finishes)"), "finishes are written with COALESCE");
    shadeUpdates.push({ shadeId: params[0], finishes: params[3], vendorHex: params[2] });
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
const { MAKEUPAPI_CODE_SUFFIX_PATTERN, makeupApiNameKey } = require("../dist/lib/makeupapi-dedupe");

function product(externalId, name, colors, extra = {}) {
  return {
    externalId,
    raw: {},
    normalized: { brand: "Example", name, colorVariants: colors.map((c) => ({ name: c, hex: "#aabbcc" })), tags: [], ...extra },
  };
}

beforeEach(() => {
  shadeUpdates = [];
  inserts = [];
  links = [];
  statements = [];
  existing = [];
});

describe("materializeMakeupApiRecords", () => {
  it("canonicalizes tag finishes on a new shade", async () => {
    await materializeMakeupApiRecords(1, [product("mk-1", "Prism", ["Prism"], { tags: ["holo", "holographic"] })], 9);
    assert.deepEqual(inserts, ["Prism"]);
    assert.equal(shadeUpdates.length, 1);
    // "holo" (alias) and "holographic" (tag) resolve to the same finish: one entry, not two.
    assert.deepEqual(shadeUpdates[0].finishes, ["holographic"]);
    assert.deepEqual(links, [{ shadeId: 901, externalId: "mk-1" }]);
  });

  it("keys on brand + color name: sibling products listing the same colors make one shade each color", async () => {
    // Dior lists the family's colors on every product of the family.
    const colors = ["745 Grenat", "673 Ruby"];
    const records = [product("ruby", "Ruby", colors), product("grenat", "Grenat", colors)];
    // The first product creates the shades; the fake then knows them for the second one.
    const metrics = await materializeMakeupApiRecords(1, records.slice(0, 1), 9);
    existing = inserts.map((name, i) => ({ shadeId: 901 + i, name, mergedInto: null }));
    const again = await materializeMakeupApiRecords(1, records.slice(1), 9);
    assert.equal(metrics.shadesCreated, 2);
    assert.equal(again.shadesCreated, 0);
    assert.equal(again.existingShadesLinked, 2);
    assert.ok(!statements.some((sql) => sql.includes("coalesce(collection, '') = coalesce($3, '')")), "collection is not part of the key");
    assert.deepEqual(
      links.map((l) => [l.shadeId, l.externalId]),
      [[901, "ruby"], [902, "ruby"], [901, "grenat"], [902, "grenat"]]
    );
  });

  it("only adds its listing to an existing shade, never its hex, color name or finishes", async () => {
    existing = [{ shadeId: 1443, name: "Monroe's Red", mergedInto: null }];
    const metrics = await materializeMakeupApiRecords(1, [product("orly-1", "Orly Nail Lacquer", ["monroe's red"], { tags: ["holo"] })], 9);
    assert.equal(metrics.shadesCreated, 0);
    assert.equal(metrics.existingShadesLinked, 1);
    assert.deepEqual(shadeUpdates, []);
    assert.deepEqual(links, [{ shadeId: 1443, externalId: "orly-1" }]);
  });

  it("resolves a merged-away name (direct or as an alias) to the survivor", async () => {
    existing = [
      // Still standing after the dedupe: the retired copy points at the store shade.
      { shadeId: 1443, name: "Monroe's Red", mergedInto: null, aliases: ["Monroe's Red (40052)"] },
      { shadeId: 3233, name: "Monroe's Red (40052)", mergedInto: 1443 },
      // Deleted after the merge: only the survivor's alias remembers the MakeupAPI name.
      { shadeId: 701, name: "Gorgeous", mergedInto: null, aliases: ["Gorgeous (40131)"] },
    ];
    await materializeMakeupApiRecords(1, [product("orly-2", "Orly Nail Lacquer", ["Monroe's Red (40052)", "Gorgeous (40131)"])], 9);
    assert.deepEqual(inserts, []);
    assert.deepEqual(links, [{ shadeId: 1443, externalId: "orly-2" }, { shadeId: 701, externalId: "orly-2" }]);
  });

  it("never matches a user's private shade", async () => {
    await materializeMakeupApiRecords(1, [product("mk-3", "Prism", ["Prism"])], 9);
    const lookups = statements.filter((sql) => sql.includes("FROM shade_alias sa") && sql.includes("regexp_replace"));
    assert.equal(lookups.length, 1);
    assert.ok(lookups[0].includes("s.status <> 'user_submitted'"));
  });

  it("matches a store shade with MakeupAPI's product code stripped, like the dedupe", async () => {
    existing = [{ shadeId: 1491, name: "Bus Stop Crimson", mergedInto: null }];
    const metrics = await materializeMakeupApiRecords(1, [product("orly-3", "Orly Nail Lacquer", ["Bus Stop Crimson (40087)"])], 9);
    assert.equal(metrics.shadesCreated, 0);
    assert.deepEqual(links, [{ shadeId: 1491, externalId: "orly-3" }]);
  });

  it("creates nothing when the name matches several shades, and ignores another category", async () => {
    existing = [
      { shadeId: 1, name: "Gorgeous", mergedInto: null },
      { shadeId: 2, name: "gorgeous (40131)", mergedInto: null },
      { shadeId: 3, name: "Prism", mergedInto: null, category: "top_coat" },
    ];
    const metrics = await materializeMakeupApiRecords(1, [product("orly-4", "Orly Nail Lacquer", ["Gorgeous", "Prism"])], 9);
    assert.equal(metrics.ambiguousShadesSkipped, 1, "Gorgeous: two shades, nothing guessed");
    assert.deepEqual(inserts, ["Prism"], "the only Prism is a top coat, so the color polish gets its own shade");
    assert.deepEqual(links, [{ shadeId: 901, externalId: "orly-4" }]);
  });
});
