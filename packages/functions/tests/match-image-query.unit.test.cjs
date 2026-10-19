const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  buildMatchCandidateWhere,
  MATCH_SCOPE_SQL,
  MATCH_HAS_HEX_SQL,
  MATCH_COLOR_ONLY_SQL,
} = require("../dist/lib/match-image-query");

const VISIBLE = "(visible)";
const none = { canonicalFinishes: [], legacyFinishes: [], families: [] };

describe("lib/match-image-query — buildMatchCandidateWhere", () => {
  it("defaults (owned scope) to the caller's owned inventory rows only, as before #105", () => {
    const { where, params } = buildMatchCandidateWhere({ scope: "owned", ...none }, VISIBLE);
    assert.equal(
      where,
      `${VISIBLE} AND ${MATCH_HAS_HEX_SQL} AND ui.inventory_item_id IS NOT NULL AND ui.status = 'owned' AND ${MATCH_COLOR_ONLY_SQL}`
    );
    assert.deepEqual(params, []);
  });

  it("wishlist scope requires the caller's wishlist row", () => {
    const { where } = buildMatchCandidateWhere({ scope: "wishlist", ...none }, VISIBLE);
    assert.match(where, /ui\.status = 'wishlist'/);
    assert.doesNotMatch(where, /'owned'/);
  });

  it("catalog scope has no inventory condition but keeps the visibility rule", () => {
    const { where } = buildMatchCandidateWhere({ scope: "catalog", ...none }, VISIBLE);
    assert.equal(MATCH_SCOPE_SQL.catalog, null);
    assert.ok(where.startsWith(VISIBLE));
    assert.doesNotMatch(where, /ui\.status/);
  });

  it("matches color polishes only in every scope (#349 D-C: toppers and coats have no single hex)", () => {
    assert.equal(MATCH_COLOR_ONLY_SQL, "s.product_category = 'color'");
    for (const scope of ["owned", "wishlist", "catalog"]) {
      assert.match(buildMatchCandidateWhere({ scope, ...none }, VISIBLE).where, /s\.product_category = 'color'/);
    }
  });

  it("every scope keeps the visibility clause first", () => {
    for (const scope of ["owned", "wishlist", "catalog"]) {
      assert.ok(buildMatchCandidateWhere({ scope, ...none }, VISIBLE).where.startsWith(`${VISIBLE} AND `));
    }
  });

  it("adds finish and family filters as numbered parameters after $1", () => {
    const { where, params } = buildMatchCandidateWhere(
      { scope: "catalog", canonicalFinishes: ["creme"], legacyFinishes: ["creme", "cream"], families: ["red", "pink"] },
      VISIBLE
    );
    assert.match(where, /&& \$2::text\[\]/);
    assert.match(where, /LOWER\(s\.finish\) = ANY\(\$3::text\[\]\)/);
    assert.match(where, /s\.color_family = ANY\(\$4::text\[\]\)/);
    assert.deepEqual(params, [["creme"], ["creme", "cream"], ["red", "pink"]]);
  });

  it("numbers a family-only filter from $2", () => {
    const { where, params } = buildMatchCandidateWhere({ scope: "owned", ...none, families: ["teal"] }, VISIBLE);
    assert.match(where, /s\.color_family = ANY\(\$2::text\[\]\)/);
    assert.deepEqual(params, [["teal"]]);
  });
});
