import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  expandUpcE,
  hasValidGtinCheckDigit,
  LIVE_BARCODE_COOLDOWN_MS,
  LIVE_BARCODE_REPEAT_MS,
  normalizeBarcodeFormat,
  normalizeScannedBarcode,
  pickBestBarcode,
  selectBarcodeEngine,
  shouldReportLiveBarcode,
  supportedNativeRetailFormats,
} from "./barcode-scan";

describe("hasValidGtinCheckDigit", () => {
  it("accepts valid GTIN-8/12/13/14 values", () => {
    assert.equal(hasValidGtinCheckDigit("4006381333931"), true); // EAN-13
    assert.equal(hasValidGtinCheckDigit("036000291452"), true); // UPC-A
    assert.equal(hasValidGtinCheckDigit("96385074"), true); // EAN-8
    assert.equal(hasValidGtinCheckDigit("10012345678902"), true); // GTIN-14
  });

  it("rejects a wrong check digit, bad lengths and non-digits", () => {
    assert.equal(hasValidGtinCheckDigit("4006381333932"), false);
    assert.equal(hasValidGtinCheckDigit("12345"), false);
    assert.equal(hasValidGtinCheckDigit("40063813339a1"), false);
    assert.equal(hasValidGtinCheckDigit(""), false);
  });
});

describe("normalizeBarcodeFormat", () => {
  it("maps BarcodeDetector, zxing and OCR spellings", () => {
    assert.equal(normalizeBarcodeFormat("ean_13"), "ean_13");
    assert.equal(normalizeBarcodeFormat("EAN_13"), "ean_13");
    assert.equal(normalizeBarcodeFormat("EAN13"), "ean_13");
    assert.equal(normalizeBarcodeFormat("UPC_A"), "upc_a");
    assert.equal(normalizeBarcodeFormat("upc_e"), "upc_e");
    assert.equal(normalizeBarcodeFormat("ean_8"), "ean_8");
  });

  it("returns null for non-retail formats", () => {
    assert.equal(normalizeBarcodeFormat("qr_code"), null);
    assert.equal(normalizeBarcodeFormat("code_128"), null);
  });
});

describe("expandUpcE", () => {
  it("expands each UPC-E compression pattern to UPC-A", () => {
    assert.equal(expandUpcE("04252614"), "042100005264"); // ends 0–2
    assert.equal(expandUpcE("01234531"), "012300000451"); // ends 3
    assert.equal(expandUpcE("01234543"), "012340000053"); // ends 4
    assert.equal(expandUpcE("01234572"), "012345000072"); // ends 5–9
  });

  it("rejects bad input", () => {
    assert.equal(expandUpcE("21234505"), null);
    assert.equal(expandUpcE("123"), null);
  });
});

describe("normalizeScannedBarcode", () => {
  it("keeps valid digits exactly as printed", () => {
    assert.deepEqual(normalizeScannedBarcode({ rawValue: " 036000291452 ", format: "upc_a" }), {
      gtin: "036000291452",
      format: "upc_a",
    });
  });

  it("validates UPC-E through its UPC-A expansion", () => {
    assert.deepEqual(normalizeScannedBarcode({ rawValue: "04252614", format: "upc_e" }), {
      gtin: "04252614",
      format: "upc_e",
    });
    assert.equal(normalizeScannedBarcode({ rawValue: "04252615", format: "upc_e" }), null);
  });

  it("rejects length/format mismatches, misreads and non-retail codes", () => {
    assert.equal(normalizeScannedBarcode({ rawValue: "036000291452", format: "ean_13" }), null);
    assert.equal(normalizeScannedBarcode({ rawValue: "4006381333932", format: "ean_13" }), null);
    assert.equal(normalizeScannedBarcode({ rawValue: "https://example.com", format: "qr_code" }), null);
  });
});

describe("pickBestBarcode", () => {
  it("prefers EAN-13 over UPC-A over EAN-8, ignoring invalid reads", () => {
    const best = pickBestBarcode([
      { rawValue: "96385074", format: "ean_8" },
      { rawValue: "036000291452", format: "upc_a" },
      { rawValue: "4006381333932", format: "ean_13" }, // bad check digit
      { rawValue: "4006381333931", format: "ean_13" },
    ]);
    assert.deepEqual(best, { gtin: "4006381333931", format: "ean_13" });
  });

  it("returns null when nothing is valid", () => {
    assert.equal(pickBestBarcode([]), null);
    assert.equal(pickBestBarcode([{ rawValue: "hello", format: "qr_code" }]), null);
  });
});

describe("selectBarcodeEngine", () => {
  it("falls back to zxing when BarcodeDetector is missing", () => {
    assert.equal(selectBarcodeEngine({ hasNativeDetector: false, nativeFormats: null }), "zxing");
  });

  it("uses the native detector when it reads EAN-13 or UPC-A", () => {
    assert.equal(
      selectBarcodeEngine({ hasNativeDetector: true, nativeFormats: ["qr_code", "ean_13", "upc_a"] }),
      "native",
    );
    assert.equal(selectBarcodeEngine({ hasNativeDetector: true, nativeFormats: ["upc_a"] }), "native");
  });

  it("falls back to zxing when the native detector reports no retail formats", () => {
    assert.equal(selectBarcodeEngine({ hasNativeDetector: true, nativeFormats: [] }), "zxing");
    assert.equal(selectBarcodeEngine({ hasNativeDetector: true, nativeFormats: ["qr_code"] }), "zxing");
    assert.equal(selectBarcodeEngine({ hasNativeDetector: true, nativeFormats: ["ean_8"] }), "zxing");
    assert.equal(selectBarcodeEngine({ hasNativeDetector: true, nativeFormats: null }), "zxing");
  });
});

describe("supportedNativeRetailFormats", () => {
  it("intersects with retail formats in preference order", () => {
    assert.deepEqual(supportedNativeRetailFormats(["upc_e", "qr_code", "ean_13", "ean_8"]), [
      "ean_13",
      "ean_8",
      "upc_e",
    ]);
    assert.deepEqual(supportedNativeRetailFormats(null), []);
  });
});

describe("shouldReportLiveBarcode", () => {
  it("reports the first read", () => {
    assert.equal(shouldReportLiveBarcode(null, "4006381333931", 0), true);
  });

  it("throttles the same code to one report per LIVE_BARCODE_REPEAT_MS", () => {
    const last = { gtin: "4006381333931", at: 1000 };
    assert.equal(shouldReportLiveBarcode(last, last.gtin, 1000 + LIVE_BARCODE_REPEAT_MS - 1), false);
    assert.equal(shouldReportLiveBarcode(last, last.gtin, 1000 + LIVE_BARCODE_REPEAT_MS), true);
  });

  it("reports a different code after the short cooldown", () => {
    const last = { gtin: "4006381333931", at: 1000 };
    assert.equal(shouldReportLiveBarcode(last, "0123456789012", 1000 + LIVE_BARCODE_COOLDOWN_MS - 1), false);
    assert.equal(shouldReportLiveBarcode(last, "0123456789012", 1000 + LIVE_BARCODE_COOLDOWN_MS), true);
  });
});
