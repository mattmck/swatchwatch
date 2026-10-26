/**
 * MakeupAPI catalog dedupe (lib/makeupapi-dedupe.ts): name key, merge plan, delete resolution and
 * request parsing. The batch's SQL was exercised against the local Postgres (see the PR notes).
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  makeupApiNameKey,
  parseMakeupApiDedupeBody,
  planMakeupApiMerges,
  resolveDeletableShades,
} = require("../dist/lib/makeupapi-dedupe");

const DIOR = 10;
const ORLY = 20;

function row(shadeId, brandId, name, extra = {}) {
  return {
    shadeId,
    brandId,
    brand: brandId === DIOR ? "Dior" : "Orly",
    name,
    status: "active",
    productCategory: "color",
    makeupApiOnly: true,
    holders: 0,
    ...extra,
  };
}

describe("makeupApiNameKey", () => {
  it("drops a trailing product code and folds case and whitespace", () => {
    assert.equal(makeupApiNameKey("Monroe's Red (40052)"), "monroe's red");
    assert.equal(makeupApiNameKey(" Fuchsia (009) "), "fuchsia");
    assert.equal(makeupApiNameKey("Drops of Jade  (55)"), "drops of jade");
    assert.equal(makeupApiNameKey("Shiny Orange Glitter (604)"), "shiny orange glitter");
    assert.equal(makeupApiNameKey("745   Grenat"), "745 grenat");
  });

  it("keeps descriptive parentheses and codes that are not a trailing parenthesis", () => {
    assert.equal(makeupApiNameKey("Bali Mist (Purple Pearl)"), "bali mist (purple pearl)");
    assert.equal(makeupApiNameKey("Cosmic Dust (Top Coat)"), "cosmic dust (top coat)");
    assert.equal(makeupApiNameKey("Hidden Gems 141"), "hidden gems 141");
    assert.notEqual(makeupApiNameKey("Purple Crush (40464)"), makeupApiNameKey("Crush"));
  });
});

describe("planMakeupApiMerges", () => {
  it("merges MakeupAPI copies into the one store shade with the same name", () => {
    const { merges, skipped } = planMakeupApiMerges([
      row(1443, ORLY, "Monroe's Red", { makeupApiOnly: false }),
      row(3233, ORLY, "Monroe's Red (40052)"),
      row(1431, ORLY, "Crush", { makeupApiOnly: false }),
      row(3240, ORLY, "Purple Crush (40464)"),
    ]);
    assert.deepEqual(skipped, []);
    assert.deepEqual(merges, [
      {
        brand: "Orly",
        key: "monroe's red",
        sourceShadeId: 3233,
        sourceName: "Monroe's Red (40052)",
        targetShadeId: 1443,
        targetName: "Monroe's Red",
        reason: "store_shade",
      },
    ]);
  });

  it("folds copies inside MakeupAPI into the most-held active copy, then the lowest id", () => {
    const plan = planMakeupApiMerges([
      row(3103, DIOR, "745 Grenat"),
      row(3107, DIOR, "745 Grenat", { holders: 2 }),
      row(3111, DIOR, "745 grenat"),
      row(3075, DIOR, "162 Miss Satin"),
      row(3079, DIOR, "162 Miss Satin"),
    ]);
    assert.deepEqual(
      plan.merges.map((m) => [m.sourceShadeId, m.targetShadeId, m.reason]),
      [
        [3079, 3075, "makeupapi_copy"],
        [3103, 3107, "makeupapi_copy"],
        [3111, 3107, "makeupapi_copy"],
      ]
    );
  });

  it("never merges across brands, and leaves a single MakeupAPI shade alone", () => {
    const { merges } = planMakeupApiMerges([row(1, DIOR, "Ruby"), row(2, ORLY, "Ruby")]);
    assert.deepEqual(merges, []);
  });

  it("skips a name two store shades share", () => {
    const { merges, skipped } = planMakeupApiMerges([
      row(1, ORLY, "Gorgeous", { makeupApiOnly: false }),
      row(2, ORLY, "gorgeous", { makeupApiOnly: false }),
      row(3, ORLY, "Gorgeous (40131)"),
    ]);
    assert.deepEqual(merges, []);
    assert.deepEqual(skipped, [{ brand: "Orly", key: "gorgeous", shadeIds: [1, 2, 3], reason: "ambiguous_store_shades" }]);
  });

  it("skips a group whose categories differ", () => {
    const { merges, skipped } = planMakeupApiMerges([
      row(1, ORLY, "Top Coat", { makeupApiOnly: false, productCategory: "top_coat" }),
      row(2, ORLY, "Top Coat (40001)"),
    ]);
    assert.deepEqual(merges, []);
    assert.equal(skipped[0].reason, "category_mismatch");
  });

  it("ignores store shades that are not active, and needs an active survivor for copies", () => {
    const { merges, skipped } = planMakeupApiMerges([
      row(1, ORLY, "Glam", { makeupApiOnly: false, status: "excluded" }),
      row(2, ORLY, "Glam (40002)", { status: "excluded" }),
      row(3, ORLY, "Glam", { status: "excluded" }),
    ]);
    assert.deepEqual(merges, []);
    assert.deepEqual(skipped, [{ brand: "Orly", key: "glam", shadeIds: [2, 3], reason: "no_active_survivor" }]);
  });

  it("an excluded MakeupAPI copy can merge into an active store shade of the same category", () => {
    const { merges } = planMakeupApiMerges([
      row(1, ORLY, "Bus Stop Crimson", { makeupApiOnly: false }),
      row(2, ORLY, "Bus Stop Crimson (40087)", { status: "excluded" }),
    ]);
    assert.deepEqual(merges.map((m) => [m.sourceShadeId, m.targetShadeId]), [[2, 1]]);
  });
});

describe("resolveDeletableShades", () => {
  it("keeps blocked shades with their reasons", () => {
    const { deletable, kept } = resolveDeletableShades([1, 2, 3], new Map([[2, ["user_inventory_item"]]]), []);
    assert.deepEqual(deletable, [1, 3]);
    assert.deepEqual([...kept], [[2, ["user_inventory_item"]]]);
  });

  it("keeps a shade a kept merged shade still points at, transitively", () => {
    // 3 → 2 → 1 (merged_into), and 3 is labeled: 2 and 1 must stay too.
    const { deletable, kept } = resolveDeletableShades(
      [1, 2, 3, 4],
      new Map([[3, ["color_training_sample"]]]),
      [
        { shadeId: 3, mergedIntoShadeId: 2 },
        { shadeId: 2, mergedIntoShadeId: 1 },
      ]
    );
    assert.deepEqual(deletable, [4]);
    assert.deepEqual(kept.get(2), ["merged shade 3"]);
    assert.deepEqual(kept.get(1), ["merged shade 2"]);
  });

  it("deletes a survivor together with the copies merged into it", () => {
    const { deletable } = resolveDeletableShades([1, 2, 3], new Map(), [
      { shadeId: 2, mergedIntoShadeId: 1 },
      { shadeId: 3, mergedIntoShadeId: 1 },
    ]);
    assert.deepEqual(deletable, [1, 2, 3]);
  });

  it("keeps a candidate referenced by a merged shade outside the candidates", () => {
    const { deletable, kept } = resolveDeletableShades([1], new Map(), [{ shadeId: 99, mergedIntoShadeId: 1 }]);
    assert.deepEqual(deletable, []);
    assert.deepEqual(kept.get(1), ["merged shade 99"]);
  });
});

describe("parseMakeupApiDedupeBody", () => {
  it("defaults to a dry run of 10 brands from the start", () => {
    assert.deepEqual(parseMakeupApiDedupeBody({}), { afterBrandId: 0, limit: 10, dryRun: true });
    assert.deepEqual(parseMakeupApiDedupeBody(null), { afterBrandId: 0, limit: 10, dryRun: true });
    assert.deepEqual(parseMakeupApiDedupeBody({ afterBrandId: 5, limit: 100, dryRun: false }), {
      afterBrandId: 5,
      limit: 100,
      dryRun: false,
    });
  });

  it("rejects bad values", () => {
    for (const bad of [{ afterBrandId: -1 }, { afterBrandId: "3" }, { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { dryRun: "false" }]) {
      assert.equal(typeof parseMakeupApiDedupeBody(bad), "string", JSON.stringify(bad));
    }
  });
});
