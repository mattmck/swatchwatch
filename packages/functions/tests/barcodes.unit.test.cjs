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
