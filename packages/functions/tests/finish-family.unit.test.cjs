/**
 * Finish families for dupe grading (#320, decision D10):
 *   - the DB CHECK constraint, docs/schema.sql and the migration backfill stay equal to the shared
 *     `FINISH_FAMILIES` / `DUPE_FINISH_FAMILIES` constants;
 *   - `buildFinishFamilyMap` layers catalog families (`finish_type.family`) over the built-ins;
 *   - the dupe rule grades an admin finish with a family `compatible` / `different`, and one
 *     without a family stays `unknown` (never penalized);
 *   - `parseFinishFamilyField` validation for the admin create/update endpoints.
 *
 * Pure: no database, no module mocks.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  CANONICAL_FINISHES,
  DUPE_FINISH_FAMILIES,
  FINISH_FAMILIES,
  buildFinishFamilyMap,
  findDupes,
  finishCompatibility,
  finishFamily,
  isFinishFamily,
  prepareDupeCandidates,
  prepareDupeShade,
} = require("swatchwatch-shared");
const { parseFinishFamilyField, toFinishFamily, FINISH_FAMILY_INVALID_MESSAGE } = require("../dist/lib/finish-family");

const MIGRATION = path.resolve(__dirname, "../migrations/20261018175839000_finish-type-family.sql");
const SCHEMA = path.resolve(__dirname, "../../../docs/schema.sql");

function upSection(sql) {
  const index = sql.indexOf("-- Down Migration");
  return index === -1 ? sql : sql.slice(0, index);
}

function checkList(sql) {
  const match = /family IN \(([^)]*)\)/.exec(sql);
  assert.ok(match, "expected a `family IN (...)` CHECK");
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

describe("finish_type.family — sync with the shared constants", () => {
  const migration = upSection(fs.readFileSync(MIGRATION, "utf8"));

  it("the migration CHECK constraint allows exactly FINISH_FAMILIES", () => {
    assert.deepEqual(checkList(migration), [...FINISH_FAMILIES]);
  });

  it("docs/schema.sql declares the same CHECK list", () => {
    const schema = fs.readFileSync(SCHEMA, "utf8");
    const table = /CREATE TABLE finish_type \(([\s\S]*?)\n\);/.exec(schema);
    assert.ok(table, "finish_type DDL in docs/schema.sql");
    assert.deepEqual(checkList(table[1]), [...FINISH_FAMILIES]);
  });

  it("the backfill seeds every built-in finish with its DUPE_FINISH_FAMILIES family", () => {
    const values = /FROM \(VALUES([\s\S]*?)\) AS seed/.exec(migration);
    assert.ok(values, "expected the backfill VALUES block");
    const seeded = Object.fromEntries(
      [...values[1].matchAll(/\(\s*'([^']+)'\s*,\s*'([^']+)'\s*\)/g)].map((m) => [m[1], m[2]])
    );
    assert.deepEqual(seeded, { ...DUPE_FINISH_FAMILIES });
  });

  it("every built-in family is a FINISH_FAMILIES value and every built-in finish but `other` has one", () => {
    for (const family of Object.values(DUPE_FINISH_FAMILIES)) assert.ok(isFinishFamily(family), family);
    assert.deepEqual(
      Object.keys(DUPE_FINISH_FAMILIES).sort(),
      CANONICAL_FINISHES.filter((name) => name !== "other").sort()
    );
  });
});

describe("buildFinishFamilyMap", () => {
  it("returns the built-in map without a catalog", () => {
    assert.equal(buildFinishFamilyMap(undefined), DUPE_FINISH_FAMILIES);
    assert.equal(buildFinishFamilyMap(null), DUPE_FINISH_FAMILIES);
    assert.equal(buildFinishFamilyMap([]), DUPE_FINISH_FAMILIES);
  });

  it("adds admin finish families, lets catalog rows win and keeps built-ins the catalog omits", () => {
    const map = buildFinishFamilyMap([
      { name: "Velvet", family: "matte" },
      { name: "chrome", family: "shimmer" },
      { name: "galaxy-bomb", family: null },
      { name: "creme", family: null },
      { name: "mystery", family: "not-a-family" },
    ]);
    assert.equal(map.velvet, "matte", "names are lowercased");
    assert.equal(map.chrome, "shimmer");
    assert.equal(map["galaxy-bomb"], null);
    assert.equal(map.creme, null, "a catalog row without a family overrides the built-in");
    assert.equal(map.mystery, null, "unknown family values are ignored");
    assert.equal(map.holographic, "holo", "built-ins the catalog does not list keep their family");
  });

  it("rows without a family key (older payloads) keep the built-in family", () => {
    const map = buildFinishFamilyMap([{ name: "creme" }, { name: "velvet" }]);
    assert.equal(map.creme, "solid");
    assert.equal(Object.prototype.hasOwnProperty.call(map, "velvet"), false);
  });
});

describe("finishCompatibility with catalog families", () => {
  const families = buildFinishFamilyMap([
    { name: "chrome", family: "shimmer" },
    { name: "velvet", family: "matte" },
    { name: "galaxy-bomb", family: null },
    { name: "holo", family: "glitter" },
  ]);

  it("an admin finish with a family grades `compatible` within its family", () => {
    assert.equal(finishCompatibility(["chrome"], ["metallic"], families), "compatible");
    assert.equal(finishCompatibility(["velvet"], ["matte"], families), "compatible");
  });

  it("an admin finish with a family grades `different` against another family", () => {
    assert.equal(finishCompatibility(["chrome"], ["creme"], families), "different");
    assert.equal(finishCompatibility(["velvet"], ["holographic"], families), "different");
  });

  it("an admin finish without a family stays `unknown` (not penalized)", () => {
    assert.equal(finishCompatibility(["galaxy-bomb"], ["creme"], families), "unknown");
    assert.equal(finishCompatibility(["galaxy-bomb"], ["galaxy-bomb"], families), "same");
    assert.equal(finishCompatibility(["chrome"], ["creme"]), "unknown", "built-in map knows no `chrome`");
  });

  it("a catalog finish named like a legacy alias keeps its own identity and family", () => {
    assert.equal(finishFamily("holo", families), "glitter");
    assert.equal(finishCompatibility(["holo"], ["holographic"], families), "different");
    assert.equal(finishFamily("holo"), "holo", "without a catalog `holo` is still the holographic alias");
  });

  it("prototype keys are not families", () => {
    assert.equal(finishFamily("constructor"), undefined);
    assert.equal(finishCompatibility(["constructor"], ["toString"]), "unknown");
  });

  it("findDupes downgrades a clearly different admin finish only when it has a family", () => {
    const target = prepareDupeShade({ shadeId: 1, vendorHex: "#B0303A", finishes: ["creme"] });
    const candidates = prepareDupeCandidates([{ shadeId: 2, vendorHex: "#B2323C", finishes: ["chrome"] }]);

    const builtIn = findDupes(target, candidates).dupes[0];
    assert.equal(builtIn.finishCompatibility, "unknown");
    assert.equal(builtIn.grade, "high");

    const withCatalog = findDupes(target, candidates, { finishFamilies: families }).dupes[0];
    assert.equal(withCatalog.finishCompatibility, "different");
    assert.equal(withCatalog.colorGrade, "high");
    assert.equal(withCatalog.grade, "medium");
  });
});

describe("parseFinishFamilyField", () => {
  it("absent means not provided", () => {
    assert.deepEqual(parseFinishFamilyField({}), { provided: false, value: null, invalid: false });
    assert.deepEqual(parseFinishFamilyField(null), { provided: false, value: null, invalid: false });
  });

  it("null or blank clears the family", () => {
    assert.deepEqual(parseFinishFamilyField({ family: null }), { provided: true, value: null, invalid: false });
    assert.deepEqual(parseFinishFamilyField({ family: "  " }), { provided: true, value: null, invalid: false });
  });

  it("accepts FINISH_FAMILIES case-insensitively", () => {
    for (const family of FINISH_FAMILIES) {
      assert.deepEqual(parseFinishFamilyField({ family }), { provided: true, value: family, invalid: false });
    }
    assert.deepEqual(parseFinishFamilyField({ family: " Holo " }), { provided: true, value: "holo", invalid: false });
  });

  it("rejects anything else", () => {
    for (const family of ["holographic", "sparkle", 3, true, ["solid"], {}]) {
      assert.equal(parseFinishFamilyField({ family }).invalid, true, JSON.stringify(family));
    }
    assert.match(FINISH_FAMILY_INVALID_MESSAGE, /solid, shimmer, holo, glitter, matte, thermal, glow/);
  });

  it("toFinishFamily drops unknown stored values", () => {
    assert.equal(toFinishFamily("matte"), "matte");
    assert.equal(toFinishFamily(null), null);
    assert.equal(toFinishFamily("legacy"), null);
  });
});
