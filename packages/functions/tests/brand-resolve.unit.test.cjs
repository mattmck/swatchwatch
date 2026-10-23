/**
 * Brand resolution for the bottle flow: the typed brand hint (and later a brand read from a
 * frame) is matched against brand.name_canonical and brand_alias.alias with pg_trgm. Runs
 * without a database: lib/brand-resolve takes the query function as an argument.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  BRAND_MATCH_MIN_SIMILARITY,
  BRAND_SHADE_NAMES_CAP,
  RESOLVE_BRAND_SQL,
  SELECT_BRAND_SHADE_NAMES_SQL,
  resolveBrandFromText,
  listBrandShadeNames,
  toBrandRef,
  toBrandHintEcho,
} = require("../dist/lib/brand-resolve");

function fakeDb(rows) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: typeof rows === "function" ? rows(sql, params) : rows, rowCount: 0 };
    },
  };
}

describe("lib/brand-resolve — resolveBrandFromText", () => {
  it("constants", () => {
    assert.equal(BRAND_MATCH_MIN_SIMILARITY, 0.6);
    assert.equal(BRAND_SHADE_NAMES_CAP, 400);
  });

  it("blank text returns null without a query", async () => {
    const db = fakeDb([]);
    assert.equal(await resolveBrandFromText("  ", db), null);
    assert.equal(db.calls.length, 0);
  });

  it("maps the best row to a numeric brand id", async () => {
    const db = fakeDb([{ brandId: "3", name: "Loud Lacquer", score: 0.71 }]);
    assert.deepEqual(await resolveBrandFromText("Loud", db), { brandId: 3, name: "Loud Lacquer", score: 0.71 });
    assert.deepEqual(db.calls[0].params, ["Loud"]);
  });

  it("trims the text it searches with", async () => {
    const db = fakeDb([{ brandId: "3", name: "Loud Lacquer", score: 0.71 }]);
    await resolveBrandFromText("  Loud ", db);
    assert.deepEqual(db.calls[0].params, ["Loud"]);
  });

  it("a score under the minimum is no match", async () => {
    const db = fakeDb([{ brandId: "3", name: "Loud Lacquer", score: 0.59 }]);
    assert.equal(await resolveBrandFromText("Loud", db), null);
  });

  it("no row is no match", async () => {
    assert.equal(await resolveBrandFromText("Loud", fakeDb([])), null);
  });

  it("the SQL scores names and aliases with pg_trgm and ranks deterministically", () => {
    assert.match(RESOLVE_BRAND_SQL, /brand_alias/);
    assert.match(RESOLVE_BRAND_SQL, /similarity\(/);
    assert.match(RESOLVE_BRAND_SQL, / % \$1/);
    assert.match(RESOLVE_BRAND_SQL, /ORDER BY (r\.)?score DESC, (r\.)?brand_id/);
    assert.match(RESOLVE_BRAND_SQL, /LIMIT 1/);
  });
});

describe("lib/brand-resolve — listBrandShadeNames", () => {
  const rows = (n) => Array.from({ length: n }, (_, i) => ({ name: `Shade ${i}` }));

  it("401 rows are trimmed to the cap and flagged truncated", async () => {
    const db = fakeDb(rows(401));
    const out = await listBrandShadeNames(3, 7, db);
    assert.equal(out.names.length, 400);
    assert.equal(out.truncated, true);
    assert.deepEqual(db.calls[0].params, [3, 7]);
  });

  it("a short list is returned whole", async () => {
    const out = await listBrandShadeNames(3, 7, fakeDb(rows(12)));
    assert.equal(out.names.length, 12);
    assert.equal(out.truncated, false);
    assert.equal(out.names[0], "Shade 0");
  });

  it("exactly the cap is not truncated", async () => {
    const out = await listBrandShadeNames(3, 7, fakeDb(rows(400)));
    assert.equal(out.names.length, 400);
    assert.equal(out.truncated, false);
  });

  it("the SQL is scoped to the caller's own private shades and to live color shades", () => {
    assert.match(SELECT_BRAND_SHADE_NAMES_SQL, /s\.brand_id = \$1/);
    assert.match(SELECT_BRAND_SHADE_NAMES_SQL, /created_by_user_id = \$2/);
    assert.match(SELECT_BRAND_SHADE_NAMES_SQL, /merged_into_shade_id IS NULL/);
    assert.match(SELECT_BRAND_SHADE_NAMES_SQL, /product_category = 'color'/);
    assert.match(SELECT_BRAND_SHADE_NAMES_SQL, /ORDER BY s\.shade_name_canonical/);
    assert.match(SELECT_BRAND_SHADE_NAMES_SQL, /LIMIT 401/);
  });
});

describe("lib/brand-resolve — refs", () => {
  it("an unmatched brand keeps the raw text and the source", () => {
    assert.deepEqual(toBrandRef(null, "Loud", "hint"), { brandId: null, name: "Loud", source: "hint" });
  });

  it("a matched brand carries the canonical name and the id as a string", () => {
    const resolved = { brandId: 3, name: "Loud Lacquer", score: 0.71 };
    assert.deepEqual(toBrandRef(resolved, "loud", "read"), { brandId: "3", name: "Loud Lacquer", source: "read" });
  });

  it("the hint echo is the raw text plus what it resolved to", () => {
    assert.deepEqual(toBrandHintEcho({ brandId: 3, name: "Loud Lacquer", score: 0.71 }, "loud"), {
      raw: "loud",
      brandId: "3",
      name: "Loud Lacquer",
    });
    assert.deepEqual(toBrandHintEcho(null, "loud"), { raw: "loud", brandId: null, name: "loud" });
  });
});
