/**
 * Barcode backfill (#21, #325): builds catalog `barcode` rows from stored connector products
 * (`external_product`) through `shade_source_product`. Dry runs report exactly what a write
 * would do (same code, rolled back). Runs without a database.
 */
const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const { runBarcodeBackfillBatch, parseBarcodeBackfillBody } = require("../dist/lib/barcode-backfill");

const UPC_A = "036000291452";
const EAN_13 = "4006381333931";
const GTIN_14 = "10012345678902";

let products;
let skus;
let barcodes;
let committed;

function seed() {
  products = [
    // Product → one shade, GTIN + variant barcode.
    { id: 1, externalId: "a", gtin: UPC_A, variants: [{ barcode: UPC_A }, { barcode: EAN_13 }], shadeIds: [11] },
    // Linked to two shades (MakeupAPI-style): ambiguous, skipped.
    { id: 2, externalId: "b", gtin: GTIN_14, variants: [], shadeIds: [21, 22] },
    // Junk barcode only.
    { id: 3, externalId: "c", gtin: "SKU-1", variants: [{ barcode: "12345" }], shadeIds: [31] },
    // Same EAN-13 as product 1 but another shade: conflict, first shade keeps it.
    { id: 4, externalId: "d", gtin: EAN_13, variants: [], shadeIds: [41] },
  ];
  skus = [{ skuId: 500, shadeId: 41 }];
  barcodes = [];
  committed = 0;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeClient(tx) {
  return {
    async query(sql, params = []) {
      const text = String(sql).replace(/\s+/g, " ").trim();
      if (/^SELECT sku_id/i.test(text)) {
        const sku = tx.skus.filter((s) => s.shadeId === params[0]).sort((a, b) => a.skuId - b.skuId)[0];
        return { rows: sku ? [{ skuId: sku.skuId }] : [], rowCount: sku ? 1 : 0 };
      }
      if (/^INSERT INTO sku/i.test(text)) {
        const sku = { skuId: 600 + tx.skus.length, shadeId: params[0] };
        tx.skus.push(sku);
        return { rows: [{ skuId: sku.skuId }], rowCount: 1 };
      }
      if (/^INSERT INTO barcode/i.test(text)) {
        if (tx.barcodes.some((b) => b.gtin === params[1])) return { rows: [], rowCount: 0 };
        tx.barcodes.push({ skuId: params[0], gtin: params[1], source: params[4], externalProductId: params[5] });
        return { rows: [{ inserted: true }], rowCount: 1 };
      }
      if (/FROM barcode b JOIN sku s ON s.sku_id = b.sku_id WHERE b.gtin = \$1/i.test(text)) {
        const row = tx.barcodes.find((b) => b.gtin === params[0]);
        const sku = row && tx.skus.find((s) => s.skuId === row.skuId);
        return { rows: sku ? [{ shadeId: sku.shadeId }] : [], rowCount: sku ? 1 : 0 };
      }
      if (/FROM barcode b JOIN sku s/i.test(text) && /s.shade_id = \$1/i.test(text)) {
        const has = tx.barcodes.some((b) => tx.skus.find((s) => s.skuId === b.skuId)?.shadeId === params[0]);
        return { rows: [{ hasBarcode: has }], rowCount: 1 };
      }
      throw new Error(`unexpected client SQL: ${text}`);
    },
  };
}

const db = {
  async query(sql, params = []) {
    const text = String(sql).replace(/\s+/g, " ");
    assert.match(text, /FROM external_product ep/);
    assert.match(text, /shade_source_product/);
    const [after, limit] = params;
    const rows = products
      .filter((p) => p.id > after)
      .slice(0, limit)
      .map((p) => ({
        externalProductId: String(p.id),
        externalId: p.externalId,
        gtin: p.gtin,
        variants: p.variants,
        shadeIds: p.shadeIds.map(String),
      }));
    return { rows, rowCount: rows.length };
  },
  async transaction(callback) {
    const tx = { skus: clone(skus), barcodes: clone(barcodes) };
    const result = await callback(makeClient(tx));
    skus = tx.skus;
    barcodes = tx.barcodes;
    committed += 1;
    return result;
  },
};

describe("parseBarcodeBackfillBody", () => {
  it("defaults to a dry run from the start", () => {
    assert.deepEqual(parseBarcodeBackfillBody({}), { afterExternalProductId: 0, limit: 200, dryRun: true });
  });

  it("rejects bad input", () => {
    assert.equal(typeof parseBarcodeBackfillBody({ limit: 0 }), "string");
    assert.equal(typeof parseBarcodeBackfillBody({ limit: 1001 }), "string");
    assert.equal(typeof parseBarcodeBackfillBody({ dryRun: "no" }), "string");
    assert.equal(typeof parseBarcodeBackfillBody({ afterExternalProductId: -1 }), "string");
  });
});

describe("runBarcodeBackfillBatch", () => {
  beforeEach(seed);

  it("reports what a write would do without changing anything in a dry run", async () => {
    const report = await runBarcodeBackfillBatch(db, { afterExternalProductId: 0, limit: 200, dryRun: true });

    assert.equal(report.dryRun, true);
    assert.equal(report.scannedProducts, 4);
    assert.equal(report.productsWithGtins, 3);
    assert.equal(report.gtinsFound, 4); // 0+UPC_A, EAN_13 (product 1), GTIN-14 (product 2), EAN_13 (product 4)
    assert.equal(report.inserted, 2);
    assert.equal(report.alreadyLinked, 0);
    assert.equal(report.shadesGainingBarcode, 1);
    assert.deepEqual(report.ambiguousProducts, [{ externalProductId: 2, shadeIds: [21, 22] }]);
    assert.deepEqual(report.conflicts, [
      { externalProductId: 4, shadeId: 41, gtin: EAN_13, existingShadeId: 11 },
    ]);
    assert.equal(report.nextAfterExternalProductId, null);
    assert.equal(barcodes.length, 0, "dry run writes nothing");
    assert.equal(skus.length, 1, "dry run creates no SKU");
  });

  it("writes the same rows the dry run reported, with backfill provenance", async () => {
    const dry = await runBarcodeBackfillBatch(db, { afterExternalProductId: 0, limit: 200, dryRun: true });
    const report = await runBarcodeBackfillBatch(db, { afterExternalProductId: 0, limit: 200, dryRun: false });

    assert.equal(report.inserted, dry.inserted);
    assert.deepEqual(report.conflicts, dry.conflicts);
    assert.deepEqual(
      barcodes.map((b) => [b.gtin, b.source, b.externalProductId]),
      [
        [`0${UPC_A}`, "backfill", 1],
        [EAN_13, "backfill", 1],
      ]
    );
  });

  it("is idempotent: a second write links nothing new", async () => {
    await runBarcodeBackfillBatch(db, { afterExternalProductId: 0, limit: 200, dryRun: false });
    const again = await runBarcodeBackfillBatch(db, { afterExternalProductId: 0, limit: 200, dryRun: false });
    assert.equal(again.inserted, 0);
    assert.equal(again.alreadyLinked, 2);
    assert.equal(again.shadesGainingBarcode, 0);
  });

  it("pages with a keyset cursor", async () => {
    const first = await runBarcodeBackfillBatch(db, { afterExternalProductId: 0, limit: 2, dryRun: true });
    assert.equal(first.scannedProducts, 2);
    assert.equal(first.nextAfterExternalProductId, 2);
    const second = await runBarcodeBackfillBatch(db, { afterExternalProductId: 2, limit: 2, dryRun: true });
    assert.equal(second.scannedProducts, 2);
    assert.equal(second.nextAfterExternalProductId, 4);
    const third = await runBarcodeBackfillBatch(db, { afterExternalProductId: 4, limit: 2, dryRun: true });
    assert.equal(third.scannedProducts, 0);
    assert.equal(third.nextAfterExternalProductId, null);
  });
});
