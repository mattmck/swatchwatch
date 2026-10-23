/**
 * Admin console backfills for connector product data (functions/product-data-admin.ts): the
 * request body parser and the one-page steps in lib/product-text-backfill.ts and
 * lib/product-price-backfill.ts that each request runs. No DB: the steps take a query
 * function, faked here.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { parseProductDataBatchBody } = require("../dist/functions/product-data-admin");
const { runProductTextBatch, runFinishFillBatch, readFinishCoverage } = require("../dist/lib/product-text-backfill");
const { createStoreCurrencyResolver, runProductPriceBatch } = require("../dist/lib/product-price-backfill");
const { DEFAULT_FINISH_CATALOG } = require("../dist/lib/finishes");

describe("parseProductDataBatchBody", () => {
  it("defaults to a dry run from the start with 500 rows", () => {
    assert.deepEqual(parseProductDataBatchBody({}, "afterShadeId"), { after: 0, limit: 500, dryRun: true, sources: null });
    assert.deepEqual(parseProductDataBatchBody(null, "afterShadeId"), { after: 0, limit: 500, dryRun: true, sources: null });
  });

  it("reads the cursor under the given key, the limit, dryRun and sources", () => {
    assert.deepEqual(
      parseProductDataBatchBody(
        { afterExternalProductId: 42, limit: 10, dryRun: false, sources: [" MakeupAPI "] },
        "afterExternalProductId"
      ),
      { after: 42, limit: 10, dryRun: false, sources: ["MakeupAPI"] }
    );
    assert.equal(parseProductDataBatchBody({ sources: [] }, "afterShadeId").sources, null, "empty list = every source");
  });

  it("rejects bad input", () => {
    assert.match(parseProductDataBatchBody({ afterShadeId: -1 }, "afterShadeId"), /afterShadeId/);
    assert.match(parseProductDataBatchBody({ afterShadeId: "5" }, "afterShadeId"), /afterShadeId/);
    assert.match(parseProductDataBatchBody({ limit: 0 }, "afterShadeId"), /limit/);
    assert.match(parseProductDataBatchBody({ limit: 1001 }, "afterShadeId"), /limit/);
    assert.match(parseProductDataBatchBody({ dryRun: "no" }, "afterShadeId"), /dryRun/);
    assert.match(parseProductDataBatchBody({ sources: "MakeupAPI" }, "afterShadeId"), /sources/);
    assert.match(parseProductDataBatchBody({ sources: [""] }, "afterShadeId"), /sources/);
  });
});

const shopifyRaw = { body_html: "<p>A squishy <b>jelly</b>.</p>", product_type: "Nail Polish", tags: ["nail-polish"] };

function fakeDb({ products = [], shades = [], sources = {} } = {}) {
  const writes = [];
  const reads = [];
  const query = async (sql, params) => {
    if (sql.includes("FROM data_source ds") && sql.includes("WHERE ds.name = $1")) {
      return { rows: sources[params[0]] ? [sources[params[0]]] : [] };
    }
    if (sql.includes("FROM external_product ep") && sql.includes("ORDER BY ep.external_product_id")) {
      reads.push(params);
      const [cursor, , limit] = params;
      return { rows: products.filter((p) => Number(p.externalProductId) > Number(cursor)).slice(0, limit) };
    }
    if (sql.startsWith("UPDATE external_product")) {
      writes.push({ kind: "product", ids: params[0], patches: params[1].map((p) => JSON.parse(p)) });
      return { rows: [] };
    }
    if (sql.includes('AS "totalShades"')) return { rows: [{ totalShades: 9, emptyFinishes: 2, emptyFinishesLinked: 1 }] };
    if (sql.includes("FROM shade s") && sql.includes("JOIN LATERAL")) {
      reads.push(params);
      const [cursor, , limit] = params;
      return { rows: shades.filter((s) => Number(s.shadeId) > Number(cursor)).slice(0, limit) };
    }
    if (sql.startsWith("UPDATE shade")) {
      writes.push({ kind: "shade", ids: params[0], lists: params[1].map((p) => JSON.parse(p)) });
      return { rows: [] };
    }
    throw new Error(`unexpected SQL: ${sql.slice(0, 80)}`);
  };
  return { query, writes, reads };
}

describe("runProductTextBatch", () => {
  const products = [
    { externalProductId: "1", sourceName: "MooncatShopify", rawJson: shopifyRaw, normalizedJson: {} },
    { externalProductId: "2", sourceName: "MakeupAPI", rawJson: { description: "x" }, normalizedJson: { descriptionText: "x", descriptors: [] } },
    { externalProductId: "3", sourceName: "MakeupAPI", rawJson: { description: "Matte" }, normalizedJson: {} },
  ];

  it("reads one page after the cursor and returns the next cursor while the page is full", async () => {
    const db = fakeDb({ products });
    const first = await runProductTextBatch(db.query, { afterExternalProductId: 0, limit: 2, sources: ["MakeupAPI"], write: false });
    assert.deepEqual(db.reads[0], ["0", ["MakeupAPI"], 2]);
    assert.deepEqual(first, { scanned: 2, changed: 1, written: 0, bySource: { MooncatShopify: 1 }, nextAfterExternalProductId: "2" });
    const last = await runProductTextBatch(db.query, { afterExternalProductId: 2, limit: 2, sources: null, write: false });
    assert.equal(last.scanned, 1);
    assert.equal(last.nextAfterExternalProductId, null, "a short page ends the scan");
    assert.equal(db.writes.length, 0, "dry run never writes");
  });

  it("writes the changed rows of the page when write is on", async () => {
    const db = fakeDb({ products });
    const batch = await runProductTextBatch(db.query, { afterExternalProductId: 0, limit: 10, sources: null, write: true });
    assert.equal(batch.written, 2);
    assert.deepEqual(db.writes.map((w) => w.ids), [["1", "3"]]);
  });
});

describe("runFinishFillBatch", () => {
  const shades = [
    { shadeId: "10", finishes: [], sourceName: "MooncatShopify", rawJson: shopifyRaw, normalizedJson: {} },
    { shadeId: "11", finishes: null, sourceName: "MakeupAPI", rawJson: { description: "Pretty" }, normalizedJson: {} },
  ];

  it("plans the fill in a dry run and writes it otherwise, returning the written shade ids", async () => {
    const dry = fakeDb({ shades });
    const planned = await runFinishFillBatch(dry.query, DEFAULT_FINISH_CATALOG, { afterShadeId: 0, limit: 5, sources: null, write: false });
    assert.deepEqual(planned, {
      scanned: 2,
      fillable: 1,
      filled: 0,
      fillableBySource: { description: 1 },
      filledShadeIds: [],
      nextAfterShadeId: null,
    });
    assert.equal(dry.writes.length, 0);

    const wet = fakeDb({ shades });
    const filled = await runFinishFillBatch(wet.query, DEFAULT_FINISH_CATALOG, { afterShadeId: 0, limit: 5, sources: null, write: true });
    assert.equal(filled.filled, 1);
    assert.deepEqual(filled.filledShadeIds, ["10"]);
    assert.deepEqual(wet.writes, [{ kind: "shade", ids: ["10"], lists: [["jelly"]] }]);
  });

  it("readFinishCoverage returns numeric counts", async () => {
    assert.deepEqual(await readFinishCoverage(fakeDb().query), { totalShades: 9, emptyFinishes: 2, emptyFinishesLinked: 1 });
  });
});

describe("runProductPriceBatch", () => {
  it("resolves each store currency once per resolver and reports it", async () => {
    const products = [
      { externalProductId: "1", sourceName: "MakeupAPI", rawJson: { price: "6.0", currency: "usd" }, normalizedJson: {} },
      { externalProductId: "2", sourceName: "MakeupAPI", rawJson: { price: "7.0", currency: "USD" }, normalizedJson: {} },
    ];
    const db = fakeDb({ products });
    const resolver = createStoreCurrencyResolver(db.query, {
      fetchCurrency: true,
      fetchStoreCurrency: async () => {
        throw new Error("MakeupAPI needs no store currency");
      },
    });
    const batch = await runProductPriceBatch(db.query, resolver, { afterExternalProductId: 0, limit: 1, sources: null, write: true });
    assert.equal(batch.scanned, 1);
    assert.equal(batch.written, 1);
    assert.equal(batch.nextAfterExternalProductId, "1");
    assert.deepEqual(db.writes[0].patches, [{ price: "6.00", currency: "USD" }]);
    assert.deepEqual(resolver.currencies, { MakeupAPI: { currency: null, origin: "not_needed" } });
  });
});
