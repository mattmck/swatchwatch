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
    assert.deepEqual(normalizeGtin(UPC_A), { gtin: `0${UPC_A}`, barcodeType: "UPC_A", checkDigitValid: true });
  });

  it("keeps an EAN-13 as is", () => {
    assert.deepEqual(normalizeGtin(EAN_13), { gtin: EAN_13, barcodeType: "EAN_13", checkDigitValid: true });
  });

  it("maps a UPC-A and the same code read as EAN-13 to the same key", () => {
    assert.equal(normalizeGtin(UPC_A).gtin, normalizeGtin(`0${UPC_A}`).gtin);
  });

  it("drops the leading zero of a GTIN-14 with indicator 0", () => {
    assert.deepEqual(normalizeGtin(`0${EAN_13}`), { gtin: EAN_13, barcodeType: "GTIN_14", checkDigitValid: true });
  });

  it("keeps a GTIN-14 with a packaging indicator", () => {
    const gtin14 = "10012345678902";
    assert.deepEqual(normalizeGtin(gtin14), { gtin: gtin14, barcodeType: "GTIN_14", checkDigitValid: true });
  });

  it("strips spaces and hyphens", () => {
    assert.equal(normalizeGtin(" 0 36000-29145 2 ").gtin, `0${UPC_A}`);
  });

  it("restores a UPC-A whose leading zero was lost (11 digits)", () => {
    assert.deepEqual(normalizeGtin(UPC_A.slice(1)), { gtin: `0${UPC_A}`, barcodeType: "UPC_A", checkDigitValid: true });
  });

  it("treats an 8-digit code as EAN-8 by default and expands UPC-E when told so", () => {
    assert.deepEqual(normalizeGtin(EAN_8), { gtin: EAN_8, barcodeType: "EAN_8", checkDigitValid: true });
    assert.deepEqual(normalizeGtin(UPC_E, "upc_e"), { gtin: "0042100005264", barcodeType: "UPC_E", checkDigitValid: true });
  });

  it("falls back to UPC-E for an 8-digit code that is not a valid EAN-8", () => {
    assert.deepEqual(normalizeGtin(UPC_E), { gtin: "0042100005264", barcodeType: "UPC_E", checkDigitValid: true });
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
    ["too short", "12345"],
    ["too long", "123456789012345"],
    ["all zeros", "0000000000000"],
  ]) {
    it(`rejects ${label}`, () => {
      assert.equal(normalizeGtin(value), null);
    });
  }
});

describe("normalizeGtin — wrong check digit is flagged, not rejected", () => {
  it("keeps a UPC-A with a bad check digit under its canonical key and flags it", () => {
    assert.deepEqual(normalizeGtin("036000291453"), { gtin: "0036000291453", barcodeType: "UPC_A", checkDigitValid: false });
  });

  it("keeps an EAN-13, GTIN-14 and 11-digit code with a bad check digit", () => {
    assert.deepEqual(normalizeGtin("4006381333932"), { gtin: "4006381333932", barcodeType: "EAN_13", checkDigitValid: false });
    assert.deepEqual(normalizeGtin("04006381333932"), { gtin: "4006381333932", barcodeType: "GTIN_14", checkDigitValid: false });
    assert.deepEqual(normalizeGtin("36000291453"), { gtin: "0036000291453", barcodeType: "UPC_A", checkDigitValid: false });
  });

  it("an 8-digit code valid as neither EAN-8 nor UPC-E is an EAN-8 as printed, flagged; with a upc_e hint it is expanded, flagged", () => {
    assert.deepEqual(normalizeGtin("04252615"), { gtin: "04252615", barcodeType: "EAN_8", checkDigitValid: false });
    assert.equal(normalizeGtin("04252615", "upc_e").barcodeType, "UPC_E");
    assert.equal(normalizeGtin("04252615", "upc_e").checkDigitValid, false);
  });

  it("the bad-check-digit and good-check-digit spellings of different digits stay different keys", () => {
    assert.notEqual(normalizeGtin("036000291453").gtin, normalizeGtin("036000291452").gtin);
  });
});

describe("normalizeGtin — equivalence classes of one code", () => {
  const canonical = `0${UPC_A}`;
  const classes = {
    "UPC-A, 12 digits": UPC_A,
    "UPC-A with spaces/hyphens": "0 36000-29145 2",
    "UPC-A lost its leading zero, 11 digits": UPC_A.slice(1),
    "UPC-A as 13-digit EAN with leading 0 (iOS)": `0${UPC_A}`,
    "UPC-A as 14-digit GTIN with 00 prefix": `00${UPC_A}`,
  };
  for (const [label, raw] of Object.entries(classes)) {
    it(`${label} → one canonical key`, () => {
      assert.equal(normalizeGtin(raw).gtin, canonical);
      assert.equal(normalizeGtin(raw).checkDigitValid, true);
      assert.deepEqual(gtinLookupKeys(raw), [canonical]);
    });
  }

  it("UPC-E expands to the same key as its UPC-A, whether 8-digit or via a 13-digit EAN", () => {
    assert.equal(normalizeGtin(UPC_E, "upc_e").gtin, "0042100005264");
    assert.equal(normalizeGtin("042100005264").gtin, "0042100005264");
    assert.equal(normalizeGtin("0042100005264").gtin, "0042100005264");
  });

  it("an EAN-13 equals its 0-prefixed GTIN-14", () => {
    assert.equal(normalizeGtin(`0${EAN_13}`).gtin, normalizeGtin(EAN_13).gtin);
  });

  it("an EAN-13 without a leading 0 is not confused with any UPC-A", () => {
    assert.equal(normalizeGtin(EAN_13).gtin, EAN_13);
    assert.equal(normalizeGtin(EAN_13).barcodeType, "EAN_13");
  });

  it("every canonical spelling is found by gtinSpellings (raw connector GTIN fallback)", () => {
    const spellings = gtinSpellings(canonical);
    for (const raw of Object.values(classes).map((v) => v.replace(/[\s-]/g, ""))) {
      assert.ok(spellings.includes(raw), `${raw} should be among ${spellings.join(", ")}`);
    }
  });
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

  it("a bad check digit still yields a key (lookup by the canonical form)", () => {
    assert.deepEqual(gtinLookupKeys("036000291453"), ["0036000291453"]);
  });

  it("is empty for junk", () => {
    assert.deepEqual(gtinLookupKeys("not-a-code"), []);
  });
});

describe("gtinSpellings", () => {
  it("lists every way a vendor may have stored the code", () => {
    assert.deepEqual(gtinSpellings(`0${UPC_A}`).sort(), [UPC_A.slice(1), UPC_A, `0${UPC_A}`, `00${UPC_A}`].sort());
    // A UPC-A that itself starts with 0 may also have lost that zero in a spreadsheet.
    assert.deepEqual(gtinSpellings(`00${UPC_A.slice(1)}`).sort(), [UPC_A.slice(1), `0${UPC_A.slice(1)}`, `00${UPC_A.slice(1)}`, `000${UPC_A.slice(1)}`].sort());
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
      { gtin: `0${UPC_A}`, barcodeType: "UPC_A", checkDigitValid: true },
      { gtin: EAN_13, barcodeType: "EAN_13", checkDigitValid: true },
    ]);
  });

  it("keeps a variant barcode with a bad check digit, flagged", () => {
    const gtins = collectProductGtins({ gtin: null, normalized: { variants: [{ barcode: "036000291453" }] } });
    assert.deepEqual(gtins, [{ gtin: "0036000291453", barcodeType: "UPC_A", checkDigitValid: false }]);
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
    assert.deepEqual(result, { inserted: 0, alreadyLinked: 0, conflicts: [], skuCreated: false, invalidCheckDigit: [] });
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
    assert.deepEqual(result, { inserted: 2, alreadyLinked: 0, conflicts: [], skuCreated: true, invalidCheckDigit: [] });
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
      invalidCheckDigit: [],
    });
    assert.equal(db.barcodes.length, 2, "the first shade keeps the GTIN");
  });

  it("stores a code with a bad check digit and reports it for the job log", async () => {
    const { db, client } = fakeCatalog({ shades: [{ shadeId: 7, brandId: 3 }] });
    const result = await upsertShadeBarcodes(client, {
      shadeId: 7,
      gtins: [{ gtin: "0036000291453", barcodeType: "UPC_A", checkDigitValid: false }],
      source: "ingestion",
    });
    assert.equal(result.inserted, 1);
    assert.deepEqual(result.invalidCheckDigit, ["0036000291453"]);
    assert.equal(db.barcodes[0].gtin, "0036000291453");
  });

  it("does nothing when the shade does not exist", async () => {
    const { db, client } = fakeCatalog();
    const result = await upsertShadeBarcodes(client, {
      shadeId: 99,
      gtins: [{ gtin: EAN_13, barcodeType: "EAN_13" }],
      source: "ingestion",
    });
    assert.deepEqual(result, { inserted: 0, alreadyLinked: 0, conflicts: [], skuCreated: false, invalidCheckDigit: [] });
    assert.equal(db.barcodes.length, 0);
  });
});
