/**
 * #352: `npm run backfill:product-text` (src/scripts/backfill-product-text.ts). No DB: the
 * script's runBackfill takes a query function, faked here.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  parseBackfillArgs,
  planProductTextPatch,
  planShadeFinishFill,
  runBackfill,
} = require("../dist/scripts/backfill-product-text");
const { DEFAULT_FINISH_CATALOG } = require("../dist/lib/finishes");
const { productTextFromRaw } = require("../dist/lib/product-text");

describe("parseBackfillArgs", () => {
  it("is a dry run by default", () => {
    const args = parseBackfillArgs([]);
    assert.equal(args.write, false);
    assert.equal(args.fillFinishes, false);
    assert.equal(args.batchSize, 500);
    assert.equal(args.limit, null);
  });

  it("parses options", () => {
    const args = parseBackfillArgs(["--write", "--fill-finishes", "--source", "A, B", "--batch-size", "50", "--limit", "7"]);
    assert.deepEqual(
      { write: args.write, fill: args.fillFinishes, sources: args.sources, batch: args.batchSize, limit: args.limit },
      { write: true, fill: true, sources: ["A", "B"], batch: 50, limit: 7 }
    );
  });

  it("rejects bad input", () => {
    assert.throws(() => parseBackfillArgs(["--dry-run", "--write"]), /mutually exclusive/);
    assert.throws(() => parseBackfillArgs(["--batch-size", "0"]), /positive integer/);
    assert.throws(() => parseBackfillArgs(["--source"]), /data_source names/);
    assert.throws(() => parseBackfillArgs(["--nope"]), /Unknown option/);
  });
});

const shopifyRaw = {
  body_html: "<p>A squishy <b>jelly</b>.</p>",
  product_type: "Nail Polish",
  tags: ["nail-polish"],
};

describe("productTextFromRaw", () => {
  it("dispatches by data source name", () => {
    assert.equal(productTextFromRaw("MooncatShopify", shopifyRaw).descriptionText, "A squishy jelly.");
    assert.equal(productTextFromRaw("MakeupAPI", { description: "Matte" }).descriptionText, "Matte");
    assert.equal(productTextFromRaw("OpenBeautyFacts", { generic_name: "Shimmer" }).descriptionText, "Shimmer");
    assert.equal(productTextFromRaw("SomethingElse", {}), null);
  });
});

describe("planProductTextPatch", () => {
  it("returns the patch when the stored text is missing or stale, null when it matches", () => {
    const patch = planProductTextPatch("MooncatShopify", shopifyRaw, { name: "X" });
    assert.deepEqual(patch, { descriptionText: "A squishy jelly.", descriptors: ["Nail Polish", "nail-polish"] });
    assert.equal(planProductTextPatch("MooncatShopify", shopifyRaw, { name: "X", ...patch }), null);
    assert.ok(planProductTextPatch("MooncatShopify", shopifyRaw, { ...patch, descriptionText: "old" }));
    assert.equal(planProductTextPatch("Unknown", shopifyRaw, {}), null);
  });
});

describe("planShadeFinishFill", () => {
  it("fills an empty shade from recomputed text, by ingestion precedence", () => {
    assert.deepEqual(planShadeFinishFill([], "MooncatShopify", shopifyRaw, { tags: [] }, DEFAULT_FINISH_CATALOG), {
      finishes: ["jelly"],
      source: "description",
    });
    assert.deepEqual(planShadeFinishFill(null, "MooncatShopify", shopifyRaw, { tags: ["Shimmer"] }), {
      finishes: ["shimmer"],
      source: "tags",
    });
  });

  it("never touches a shade that has finishes, or when nothing is found", () => {
    assert.equal(planShadeFinishFill(["creme"], "MooncatShopify", shopifyRaw, { tags: ["Shimmer"] }), null);
    assert.equal(planShadeFinishFill([], "MooncatShopify", { body_html: "Pretty pink" }, {}), null);
  });
});

describe("runBackfill (fake DB)", () => {
  function fakeDb() {
    const writes = [];
    const products = [
      { externalProductId: "1", sourceName: "MooncatShopify", rawJson: shopifyRaw, normalizedJson: { brand: "Mooncat" } },
      { externalProductId: "2", sourceName: "MakeupAPI", rawJson: { description: "x" }, normalizedJson: { descriptionText: "x", descriptors: [] } },
      { externalProductId: "3", sourceName: "MakeupAPI", rawJson: { description: "Matte finish" }, normalizedJson: {} },
    ];
    const shades = [
      { shadeId: "10", finishes: [], sourceName: "MooncatShopify", rawJson: shopifyRaw, normalizedJson: { brand: "Mooncat" } },
      { shadeId: "11", finishes: null, sourceName: "MakeupAPI", rawJson: { description: "Pretty" }, normalizedJson: {} },
    ];
    const query = async (sql, params) => {
      if (sql.includes("FROM external_product ep") && sql.includes("ORDER BY ep.external_product_id")) {
        const [cursor, , limit] = params;
        return { rows: products.filter((p) => Number(p.externalProductId) > Number(cursor)).slice(0, limit) };
      }
      if (sql.startsWith("UPDATE external_product")) {
        writes.push({ kind: "product", ids: params[0], patches: params[1].map((p) => JSON.parse(p)) });
        return { rows: [] };
      }
      if (sql.includes('AS "totalShades"')) {
        return { rows: [{ totalShades: 5, emptyFinishes: 2, emptyFinishesLinked: 2 }] };
      }
      if (sql.includes("FROM shade s") && sql.includes("JOIN LATERAL")) {
        const [cursor, , limit] = params;
        return { rows: shades.filter((s) => Number(s.shadeId) > Number(cursor)).slice(0, limit) };
      }
      if (sql.startsWith("UPDATE shade")) {
        writes.push({ kind: "shade", ids: params[0], lists: params[1].map((p) => JSON.parse(p)) });
        return { rows: [] };
      }
      throw new Error(`unexpected SQL: ${sql.slice(0, 80)}`);
    };
    return { query, writes };
  }

  const quiet = { log: () => {}, catalog: DEFAULT_FINISH_CATALOG };

  it("dry run reports product changes and finish coverage without writing", async () => {
    const db = fakeDb();
    const summary = await runBackfill(parseBackfillArgs(["--batch-size", "2"]), { ...quiet, query: db.query });
    assert.equal(db.writes.length, 0);
    assert.deepEqual(summary.products, { scanned: 3, changed: 2, written: 0, bySource: { MooncatShopify: 1, MakeupAPI: 1 } });
    assert.deepEqual(summary.coverage, {
      totalShades: 5,
      emptyFinishesBefore: 2,
      emptyFinishesLinked: 2,
      fillable: 1,
      fillableBySource: { description: 1 },
      emptyFinishesAfter: 1,
      filled: 0,
    });
  });

  it("--write updates product text in pages; finishes only with --fill-finishes", async () => {
    const db = fakeDb();
    const summary = await runBackfill(parseBackfillArgs(["--write", "--batch-size", "2"]), { ...quiet, query: db.query });
    assert.equal(summary.products.written, 2);
    assert.deepEqual(
      db.writes.filter((w) => w.kind === "product").map((w) => w.ids),
      [["1"], ["3"]]
    );
    assert.equal(db.writes.filter((w) => w.kind === "shade").length, 0);

    const db2 = fakeDb();
    const filled = await runBackfill(parseBackfillArgs(["--write", "--fill-finishes"]), { ...quiet, query: db2.query });
    assert.equal(filled.coverage.filled, 1);
    assert.deepEqual(db2.writes.find((w) => w.kind === "shade"), { kind: "shade", ids: ["10"], lists: [["jelly"]] });
  });

  it("--limit stops after N product rows", async () => {
    const db = fakeDb();
    const summary = await runBackfill(parseBackfillArgs(["--limit", "1"]), { ...quiet, query: db.query });
    assert.equal(summary.products.scanned, 1);
  });
});
