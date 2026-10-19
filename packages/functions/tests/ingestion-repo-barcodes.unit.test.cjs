/**
 * Ingestion materialization writes catalog barcodes (#21, #325): every Shopify-style product
 * links its GTIN and variant barcodes to the materialized shade, and a GTIN another shade
 * already owns is kept by that shade and reported in the job log.
 */
const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

delete process.env.AZURE_STORAGE_CONNECTION;

function mockDistModule(relativePath, exports) {
  const resolved = path.resolve(__dirname, "../dist/lib", relativePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const SHADE_ID = 31;
const OTHER_SHADE_ID = 32;
const EXTERNAL_PRODUCT_ID = 44;
const UPC_A = "036000291452";
const EAN_13 = "4006381333931";

let skus;
let barcodes;
let calls;

const transactionClient = {
  async query(sql, params = []) {
    const text = String(sql).replace(/\s+/g, " ");
    calls.push({ sql: text, params });
    if (text.includes("FROM brand")) return { rows: [{ brandId: 1 }] };
    if (text.includes("FROM shade") && text.includes("SELECT shade_id")) return { rows: [{ shadeId: SHADE_ID }] };
    if (/SELECT external_product_id/i.test(text) && text.includes("FROM external_product")) {
      return { rows: [{ externalProductId: EXTERNAL_PRODUCT_ID }], rowCount: 1 };
    }
    if (/^SELECT sku_id/i.test(text.trim())) {
      const sku = skus.find((s) => s.shadeId === params[0]);
      return { rows: sku ? [{ skuId: sku.skuId }] : [], rowCount: sku ? 1 : 0 };
    }
    if (/^INSERT INTO sku/i.test(text.trim())) {
      const sku = { skuId: 900 + skus.length, shadeId: params[0] };
      skus.push(sku);
      return { rows: [{ skuId: sku.skuId }], rowCount: 1 };
    }
    if (/^INSERT INTO barcode/i.test(text.trim())) {
      if (barcodes.some((b) => b.gtin === params[1])) return { rows: [], rowCount: 0 };
      barcodes.push({ skuId: params[0], gtin: params[1], barcodeType: params[2], source: params[4], externalProductId: params[5] });
      return { rows: [{ inserted: true }], rowCount: 1 };
    }
    if (text.includes("FROM barcode b JOIN sku s")) {
      const row = barcodes.find((b) => b.gtin === params[0]);
      const sku = row && skus.find((s) => s.skuId === row.skuId);
      return { rows: sku ? [{ shadeId: sku.shadeId }] : [], rowCount: sku ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 };
  },
};

mockDistModule("db.js", {
  query: async () => ({ rows: [] }),
  transaction: async (callback) => callback(transactionClient),
});
mockDistModule("blob-storage.js", {
  ensureContainer: async () => {},
  uploadSourceImageToBlob: async () => {
    throw new Error("no images in these tests");
  },
});
mockDistModule("ai-color-detection.js", {
  detectHexWithAzureOpenAI: async () => {
    throw new Error("AI not expected in these tests");
  },
});
mockDistModule("azure-openai-batch.js", {
  submitVisionHexBatch: async () => {
    throw new Error("batch not expected in these tests");
  },
});

const { materializeHoloTacoRecords } = require("../dist/lib/ingestion-repo");

function record({ gtin, variantBarcodes }) {
  return {
    externalId: "p1",
    gtin,
    raw: {},
    normalized: {
      brand: "Test Brand",
      name: "Shade 1",
      imageUrls: [],
      tags: [],
      collections: [],
      finishes: [],
      variants: variantBarcodes.map((barcode, i) => ({ id: i + 1, title: `Size ${i}`, barcode })),
    },
  };
}

function logger() {
  const entries = [];
  return {
    entries,
    info: (message, data) => entries.push({ level: "info", message, data }),
    warn: (message, data) => entries.push({ level: "warn", message, data }),
    error: (message, data) => entries.push({ level: "error", message, data }),
    debug: () => {},
  };
}

describe("materializeHoloTacoRecords barcodes", () => {
  beforeEach(() => {
    skus = [];
    barcodes = [];
    calls = [];
  });

  it("links the product GTIN and each variant barcode to the shade with provenance", async () => {
    const metrics = await materializeHoloTacoRecords(
      1,
      7,
      [record({ gtin: UPC_A, variantBarcodes: [UPC_A, EAN_13, "not-a-barcode"] })],
      { detectHexFromImage: false }
    );

    assert.deepEqual(
      barcodes.map((b) => [b.gtin, b.barcodeType, b.source, b.externalProductId]),
      [
        [`0${UPC_A}`, "UPC_A", "ingestion", EXTERNAL_PRODUCT_ID],
        [EAN_13, "EAN_13", "ingestion", EXTERNAL_PRODUCT_ID],
      ]
    );
    assert.deepEqual(skus.map((s) => s.shadeId), [SHADE_ID]);
    assert.equal(metrics.barcodesLinked, 2);
    assert.equal(metrics.barcodeConflicts, 0);
  });

  it("is idempotent on a re-run", async () => {
    const input = [record({ gtin: UPC_A, variantBarcodes: [UPC_A] })];
    await materializeHoloTacoRecords(1, 7, input, { detectHexFromImage: false });
    const second = await materializeHoloTacoRecords(1, 7, input, { detectHexFromImage: false });
    assert.equal(barcodes.length, 1);
    assert.equal(skus.length, 1);
    assert.equal(second.barcodesLinked, 0);
  });

  it("keeps a GTIN on the shade that claimed it first and logs the conflict", async () => {
    skus.push({ skuId: 800, shadeId: OTHER_SHADE_ID });
    barcodes.push({ skuId: 800, gtin: EAN_13, source: "ingestion" });
    const progressLogger = logger();

    const metrics = await materializeHoloTacoRecords(
      1,
      7,
      [record({ gtin: EAN_13, variantBarcodes: [EAN_13] })],
      { detectHexFromImage: false, progressLogger }
    );

    assert.equal(barcodes.length, 1);
    assert.equal(barcodes[0].skuId, 800, "the first shade keeps the GTIN");
    assert.equal(metrics.barcodeConflicts, 1);
    const warning = progressLogger.entries.find((e) => e.level === "warn" && /barcode/i.test(e.message));
    assert.ok(warning, "conflict is written to the job log");
    assert.match(warning.message, new RegExp(EAN_13));
    assert.deepEqual(warning.data, {
      externalId: "p1",
      gtin: EAN_13,
      shadeId: SHADE_ID,
      existingShadeId: OTHER_SHADE_ID,
    });
  });

  it("issues no barcode SQL for a product without barcodes", async () => {
    await materializeHoloTacoRecords(1, 7, [record({ gtin: null, variantBarcodes: [""] })], {
      detectHexFromImage: false,
    });
    assert.equal(calls.filter((c) => /barcode|\bsku\b/i.test(c.sql)).length, 0);
  });
});
