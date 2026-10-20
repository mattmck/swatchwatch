/**
 * Barcode (GTIN) normalization and shade barcode materialization (#21, #325).
 * Runs without a database: DB helpers take an injected client whose queries are faked.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeGtin,
  gtinLookupKeys,
  gtinSpellings,
  collectProductGtins,
} = require("../dist/lib/barcodes");

// Real, check-digit-valid codes.
const UPC_A = "036000291452"; // GS1 example UPC-A
const EAN_13 = "4006381333931"; // GS1 example EAN-13
const EAN_8 = "96385074"; // valid EAN-8
const UPC_E = "04252614"; // UPC-E, expands to UPC-A 042100005264

describe("normalizeGtin", () => {
  it("stores a UPC-A as its 13-digit EAN form", () => {
    assert.deepEqual(normalizeGtin(UPC_A), { gtin: `0${UPC_A}`, barcodeType: "UPC_A" });
  });

  it("keeps an EAN-13 as is", () => {
    assert.deepEqual(normalizeGtin(EAN_13), { gtin: EAN_13, barcodeType: "EAN_13" });
  });

  it("maps a UPC-A and the same code read as EAN-13 to the same key", () => {
    assert.equal(normalizeGtin(UPC_A).gtin, normalizeGtin(`0${UPC_A}`).gtin);
  });

  it("drops the leading zero of a GTIN-14 with indicator 0", () => {
    assert.deepEqual(normalizeGtin(`0${EAN_13}`), { gtin: EAN_13, barcodeType: "GTIN_14" });
  });

  it("keeps a GTIN-14 with a packaging indicator", () => {
    const gtin14 = "10012345678902";
    assert.deepEqual(normalizeGtin(gtin14), { gtin: gtin14, barcodeType: "GTIN_14" });
  });

  it("strips spaces and hyphens", () => {
    assert.equal(normalizeGtin(" 0 36000-29145 2 ").gtin, `0${UPC_A}`);
  });

  it("restores a UPC-A whose leading zero was lost (11 digits)", () => {
    assert.deepEqual(normalizeGtin(UPC_A.slice(1)), { gtin: `0${UPC_A}`, barcodeType: "UPC_A" });
  });

  it("treats an 8-digit code as EAN-8 by default and expands UPC-E when told so", () => {
    assert.deepEqual(normalizeGtin(EAN_8), { gtin: EAN_8, barcodeType: "EAN_8" });
    assert.deepEqual(normalizeGtin(UPC_E, "upc_e"), { gtin: "0042100005264", barcodeType: "UPC_E" });
  });

  it("falls back to UPC-E for an 8-digit code that is not a valid EAN-8", () => {
    assert.deepEqual(normalizeGtin(UPC_E), { gtin: "0042100005264", barcodeType: "UPC_E" });
  });

  it("honours an upc_a / ean_13 format hint for the type", () => {
    assert.equal(normalizeGtin(`0${UPC_A}`, "upc_a").barcodeType, "UPC_A");
    assert.equal(normalizeGtin(UPC_A, "EAN_13").barcodeType, "UPC_A");
  });

  for (const [label, value] of [
    ["empty", ""],
    ["null", null],
    ["a number", 36000291452],
    ["letters (a SKU typed into the barcode field)", "HT-0123"],
    ["wrong check digit", "036000291453"],
    ["too short", "12345"],
    ["too long", "123456789012345"],
    ["all zeros", "0000000000000"],
  ]) {
    it(`rejects ${label}`, () => {
      assert.equal(normalizeGtin(value), null);
    });
  }
});

describe("gtinLookupKeys", () => {
  it("returns the canonical key for an unambiguous code", () => {
    assert.deepEqual(gtinLookupKeys(UPC_A), [`0${UPC_A}`]);
  });

  it("tries both readings of an 8-digit code without a format hint", () => {
    // 04252614 is a valid UPC-E; check whether it is also a valid EAN-8 and expect both then.
    const keys = gtinLookupKeys(UPC_E);
    assert.ok(keys.includes("0042100005264"));
  });

  it("is empty for junk", () => {
    assert.deepEqual(gtinLookupKeys("not-a-code"), []);
  });
});

describe("gtinSpellings", () => {
  it("lists every way a vendor may have stored the code", () => {
    assert.deepEqual(gtinSpellings(`0${UPC_A}`).sort(), [UPC_A, `0${UPC_A}`, `00${UPC_A}`].sort());
  });

  it("does not invent a 12-digit form for an EAN-13 that does not start with 0", () => {
    assert.deepEqual(gtinSpellings(EAN_13).sort(), [EAN_13, `0${EAN_13}`].sort());
  });
});

describe("collectProductGtins", () => {
  it("collects the product GTIN then each distinct valid variant barcode", () => {
    const gtins = collectProductGtins({
      gtin: UPC_A,
      normalized: {
        variants: [
          { barcode: `0${UPC_A}` }, // same code, EAN spelling: deduped
          { barcode: EAN_13 },
          { barcode: "" },
          { barcode: "SKU-42" },
          { title: "no barcode" },
        ],
      },
    });
    assert.deepEqual(gtins, [
      { gtin: `0${UPC_A}`, barcodeType: "UPC_A" },
      { gtin: EAN_13, barcodeType: "EAN_13" },
    ]);
  });

  it("tolerates a record without variants or GTIN", () => {
    assert.deepEqual(collectProductGtins({ gtin: null, normalized: {} }), []);
    assert.deepEqual(collectProductGtins({ normalized: { variants: "nope" } }), []);
  });
});

// ---------------------------------------------------------------------------
// upsertShadeBarcodes: fake client over in-memory sku/barcode tables
// ---------------------------------------------------------------------------

const { upsertShadeBarcodes } = require("../dist/lib/barcodes");

function fakeCatalog({ skus = [], barcodes = [], shades = [] } = {}) {
  const db = {
    shades: new Map(shades.map((s) => [s.shadeId, s])),
    skus: [...skus],
    barcodes: [...barcodes],
    nextSku: 1000,
    nextBarcode: 5000,
    calls: [],
  };
  const client = {
    async query(sql, params = []) {
      const text = String(sql).replace(/\s+/g, " ");
      db.calls.push({ sql: text, params });
      if (/^SELECT sku_id/i.test(text.trim()) && /FROM sku WHERE shade_id = \$1/i.test(text)) {
        const sku = db.skus.filter((s) => s.shadeId === params[0]).sort((a, b) => a.skuId - b.skuId)[0];
        return { rows: sku ? [{ skuId: sku.skuId }] : [], rowCount: sku ? 1 : 0 };
      }
      if (/^INSERT INTO sku/i.test(text.trim())) {
        const shade = db.shades.get(params[0]);
        if (!shade) return { rows: [], rowCount: 0 };
        const sku = { skuId: db.nextSku++, shadeId: shade.shadeId, brandId: shade.brandId };
        db.skus.push(sku);
        return { rows: [{ skuId: sku.skuId }], rowCount: 1 };
      }
      if (/^INSERT INTO barcode/i.test(text.trim())) {
        const [skuId, gtin, barcodeType, isPrimary, source, externalProductId] = params;
        if (db.barcodes.some((b) => b.gtin === gtin)) return { rows: [], rowCount: 0 };
        db.barcodes.push({ barcodeId: db.nextBarcode++, skuId, gtin, barcodeType, isPrimary, source, externalProductId });
        return { rows: [{ inserted: true }], rowCount: 1 };
      }
      if (/FROM barcode b JOIN sku s/i.test(text)) {
        const row = db.barcodes.find((b) => b.gtin === params[0]);
        const sku = row && db.skus.find((s) => s.skuId === row.skuId);
        return { rows: sku ? [{ shadeId: sku.shadeId }] : [], rowCount: sku ? 1 : 0 };
      }
      throw new Error(`unexpected SQL: ${text}`);
    },
  };
  return { db, client };
}

describe("upsertShadeBarcodes", () => {
  it("does nothing (no SQL) without GTINs", async () => {
    const { db, client } = fakeCatalog();
    const result = await upsertShadeBarcodes(client, { shadeId: 7, gtins: [], source: "ingestion" });
    assert.deepEqual(result, { inserted: 0, alreadyLinked: 0, conflicts: [], skuCreated: false });
    assert.equal(db.calls.length, 0);
  });

  it("creates a SKU for a shade without one and links every GTIN to it", async () => {
    const { db, client } = fakeCatalog({ shades: [{ shadeId: 7, brandId: 3 }] });
    const result = await upsertShadeBarcodes(client, {
      shadeId: 7,
      gtins: [
        { gtin: `0${UPC_A}`, barcodeType: "UPC_A" },
        { gtin: EAN_13, barcodeType: "EAN_13" },
      ],
      source: "ingestion",
      externalProductId: 44,
    });
    assert.deepEqual(result, { inserted: 2, alreadyLinked: 0, conflicts: [], skuCreated: true });
    assert.equal(db.skus.length, 1);
    assert.deepEqual(
      db.barcodes.map((b) => [b.skuId, b.gtin, b.barcodeType, b.isPrimary, b.source, b.externalProductId]),
      [
        [1000, `0${UPC_A}`, "UPC_A", true, "ingestion", 44],
        [1000, EAN_13, "EAN_13", false, "ingestion", 44],
      ]
    );
  });

  it("reuses the shade's existing SKU", async () => {
    const { db, client } = fakeCatalog({
      shades: [{ shadeId: 7, brandId: 3 }],
      skus: [{ skuId: 12, shadeId: 7 }, { skuId: 11, shadeId: 7 }],
    });
    const result = await upsertShadeBarcodes(client, {
      shadeId: 7,
      gtins: [{ gtin: EAN_13, barcodeType: "EAN_13" }],
      source: "backfill",
    });
    assert.equal(result.skuCreated, false);
    assert.equal(db.barcodes[0].skuId, 11);
    assert.equal(db.barcodes[0].externalProductId, null);
  });

  it("counts a GTIN already linked to the same shade and keeps the first shade on a conflict", async () => {
    const { db, client } = fakeCatalog({
      shades: [{ shadeId: 7, brandId: 3 }, { shadeId: 8, brandId: 3 }],
      skus: [{ skuId: 11, shadeId: 7 }, { skuId: 21, shadeId: 8 }],
      barcodes: [
        { barcodeId: 1, skuId: 11, gtin: EAN_13 },
        { barcodeId: 2, skuId: 21, gtin: `0${UPC_A}` },
      ],
    });
    const result = await upsertShadeBarcodes(client, {
      shadeId: 7,
      gtins: [
        { gtin: EAN_13, barcodeType: "EAN_13" },
        { gtin: `0${UPC_A}`, barcodeType: "UPC_A" },
      ],
      source: "ingestion",
    });
    assert.deepEqual(result, {
      inserted: 0,
      alreadyLinked: 1,
      conflicts: [{ gtin: `0${UPC_A}`, existingShadeId: 8 }],
      skuCreated: false,
    });
    assert.equal(db.barcodes.length, 2, "the first shade keeps the GTIN");
  });

  it("does nothing when the shade does not exist", async () => {
    const { db, client } = fakeCatalog();
    const result = await upsertShadeBarcodes(client, {
      shadeId: 99,
      gtins: [{ gtin: EAN_13, barcodeType: "EAN_13" }],
      source: "ingestion",
    });
    assert.deepEqual(result, { inserted: 0, alreadyLinked: 0, conflicts: [], skuCreated: false });
    assert.equal(db.barcodes.length, 0);
  });
});
