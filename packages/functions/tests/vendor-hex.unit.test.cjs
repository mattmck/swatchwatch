const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// #321 / D12: an admin-promoted manual label in shade.vendor_hex survives re-ingestion.

delete process.env.AZURE_STORAGE_CONNECTION;
process.env.HEX_DETECTION_DELAY_MS = "0";

function mockDistModule(relativePath, exports) {
  const resolved = path.resolve(__dirname, "../dist/lib", relativePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// ---------------------------------------------------------------------------
// One in-memory shade row (id 42) that the ingest's SELECT … FOR UPDATE reads and its UPDATE writes.
// ---------------------------------------------------------------------------

let shadeRow;
let lockedReads;

const transactionClient = {
  async query(sql, params) {
    if (sql.includes("RETURNING brand_id")) return { rows: [{ brandId: 1 }] };
    if (sql.includes("lower(shade_name_canonical) = lower($2)") && sql.includes("SELECT shade_id")) {
      return { rows: shadeRow ? [{ shadeId: 42 }] : [] };
    }
    if (sql.includes("RETURNING shade_id")) {
      shadeRow = { vendorHex: null, vendorHexSource: null, vendorHexPrevious: null, vendorHexSetAt: null };
      return { rows: [{ shadeId: 42 }] };
    }
    if (sql.includes('vendor_hex_source AS "vendorHexSource"') && sql.includes("FROM shade WHERE shade_id = $1")) {
      if (sql.includes("FOR UPDATE")) lockedReads += 1;
      return {
        rows: [{ ...shadeRow, detectedHex: null, detectedFinishes: null, nameHex: null, finishes: [] }],
      };
    }
    if (sql.includes("UPDATE shade") && sql.includes("vendor_hex_source = $13::text")) {
      // [shadeId, name, vendorHex, detectedHex, finishes, overwrite, nameHex, mergedFinishes,
      //  confidence, method, model, promptVersion, vendorHexSource, vendorHexPrevious, changed]
      shadeRow = {
        vendorHex: params[2],
        vendorHexSource: params[12],
        vendorHexPrevious: params[13],
        vendorHexSetAt: params[14] ? "now" : shadeRow.vendorHexSetAt,
      };
      return { rows: [] };
    }
    if (sql.includes("RETURNING image_id")) return { rows: [{ imageId: 7 }] };
    return { rows: [] };
  },
};

mockDistModule("db.js", {
  query: async () => ({ rows: [] }),
  transaction: async (callback) => callback(transactionClient),
});
mockDistModule("blob-storage.js", {
  ensureContainer: async () => {},
  uploadSourceImageToBlob: async () => {
    throw new Error("no uploads expected");
  },
});
mockDistModule("azure-openai-batch.js", {
  submitVisionHexBatch: async () => {
    throw new Error("batch not expected");
  },
});

const { materializeHoloTacoRecords } = require("../dist/lib/ingestion-repo");
const { planIngestedVendorHex } = require("../dist/lib/vendor-hex");

function product(vendorHex) {
  return {
    externalId: "p1",
    raw: {},
    normalized: {
      brand: "Test Brand",
      name: "Shade One",
      vendorHex,
      imageUrls: [],
      tags: [],
      collections: [],
      finishes: [],
    },
  };
}

const ingest = (vendorHex, options = {}) => materializeHoloTacoRecords(1, 7, [product(vendorHex)], options);

describe("planIngestedVendorHex", () => {
  const vendor = { vendorHex: "#111111", vendorHexSource: "vendor", vendorHexPrevious: null };
  const promoted = { vendorHex: "#ABCDEF", vendorHexSource: "manual_label", vendorHexPrevious: "#111111" };

  it("fills a new shade and marks it vendor data", () => {
    assert.deepEqual(planIngestedVendorHex(null, "#222222", false), {
      vendorHex: "#222222",
      vendorHexSource: "vendor",
      vendorHexPrevious: null,
      vendorHexChanged: true,
    });
  });

  it("follows the connector's overwrite rule for vendor data", () => {
    assert.equal(planIngestedVendorHex(vendor, "#222222", true).vendorHex, "#222222");
    assert.equal(planIngestedVendorHex(vendor, "#222222", false).vendorHex, "#111111");
    assert.equal(planIngestedVendorHex(vendor, null, true).vendorHex, "#111111");
    assert.equal(planIngestedVendorHex(vendor, "#111111", true).vendorHexChanged, false);
  });

  it("never replaces a promoted manual label and records the vendor value for Undo", () => {
    const overwrite = planIngestedVendorHex(promoted, "#222222", true);
    assert.deepEqual(overwrite, {
      vendorHex: "#ABCDEF",
      vendorHexSource: "manual_label",
      vendorHexPrevious: "#222222",
      vendorHexChanged: false,
    });
    assert.equal(planIngestedVendorHex(promoted, "#222222", false).vendorHexPrevious, "#111111");
    assert.equal(
      planIngestedVendorHex({ ...promoted, vendorHexPrevious: null }, "#222222", false).vendorHexPrevious,
      "#222222"
    );
    assert.equal(planIngestedVendorHex(promoted, null, true).vendorHexPrevious, "#111111");
  });

  it("keeps an unknown source when the ingest brings no vendor hex", () => {
    const unknown = { vendorHex: "#333333", vendorHexSource: null, vendorHexPrevious: null };
    assert.equal(planIngestedVendorHex(unknown, null, true).vendorHexSource, null);
  });
});

describe("materializeHoloTacoRecords vendor_hex guard (#321)", () => {
  beforeEach(() => {
    shadeRow = null;
    lockedReads = 0;
  });

  it("keeps a promoted hex through a re-ingest of the same product", async () => {
    await ingest("#111111");
    assert.deepEqual(
      { hex: shadeRow.vendorHex, source: shadeRow.vendorHexSource },
      { hex: "#111111", source: "vendor" }
    );

    // Admin promotes the shade's manual label (what promoteManualLabel writes).
    shadeRow = { vendorHex: "#ABCDEF", vendorHexSource: "manual_label", vendorHexPrevious: "#111111", vendorHexSetAt: "promoted" };

    // The vendor changed its hex; even an overwriting re-ingest must not touch the promoted value.
    await ingest("#222222", { overwriteDetectedHex: true });
    assert.equal(shadeRow.vendorHex, "#ABCDEF");
    assert.equal(shadeRow.vendorHexSource, "manual_label");
    assert.equal(shadeRow.vendorHexPrevious, "#222222");
    assert.equal(shadeRow.vendorHexSetAt, "promoted");
    assert.ok(lockedReads >= 2, "the shade row is read FOR UPDATE before planning");

    await ingest("#333333");
    assert.equal(shadeRow.vendorHex, "#ABCDEF");
    assert.equal(shadeRow.vendorHexPrevious, "#222222");
  });

  it("still updates an unpromoted shade's vendor hex when overwriting", async () => {
    await ingest("#111111");
    await ingest("#222222", { overwriteDetectedHex: true });
    assert.equal(shadeRow.vendorHex, "#222222");
    assert.equal(shadeRow.vendorHexSource, "vendor");
  });
});

// ---------------------------------------------------------------------------
// promoteManualLabel / demote*: fake client with one label and one shade row.
// ---------------------------------------------------------------------------

const { promoteManualLabel, demoteManualLabel, demoteShadeVendorHex } = require("../dist/lib/vendor-hex");

function fakeDb({ label, shade }) {
  const state = { label, shade: { ...shade }, audits: [], updates: 0 };
  state.client = {
    async query(sql, params) {
      if (sql.includes("FROM color_training_sample")) {
        assert.ok(sql.includes("source_type = 'manual'"), "only manual labels");
        assert.ok(sql.includes("FOR UPDATE"));
        return { rows: state.label && Number(state.label.labelId) === params[0] ? [state.label] : [] };
      }
      if (sql.includes("FROM shade") && sql.includes("FOR UPDATE")) {
        return { rows: state.shade && String(state.shade.shadeId) === String(params[0]) ? [state.shade] : [] };
      }
      if (sql.startsWith("UPDATE shade")) {
        state.updates += 1;
        const promote = sql.includes("vendor_hex_source = 'manual_label'");
        state.shade = promote
          ? { ...state.shade, vendorHex: params[1], vendorHexSource: "manual_label", vendorHexLabelId: params[2], vendorHexPrevious: params[4] }
          : { ...state.shade, vendorHex: params[1], vendorHexSource: params[2], vendorHexLabelId: null, vendorHexPrevious: null };
        return { rows: [state.shade] };
      }
      if (sql.includes("INSERT INTO admin_audit_event")) {
        state.audits.push({ actor: params[0], target: params[1], action: params[2], changes: JSON.parse(params[3]) });
        return { rows: [] };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  return state;
}

const baseShade = { shadeId: "5", status: "active", vendorHex: "#111111", vendorHexSource: "vendor", vendorHexLabelId: null, vendorHexPrevious: null };
const approved = { labelId: "9", shadeId: "5", hex: "#ABCDEF", trainingStatus: "approved" };

describe("promoteManualLabel", () => {
  it("promotes, keeps the previous vendor hex and writes one audit row", async () => {
    const db = fakeDb({ label: approved, shade: baseShade });
    const result = await promoteManualLabel(db.client, 9, 3);
    assert.equal(result.ok, true);
    assert.deepEqual(result.body, {
      shadeId: "5", vendorHex: "#ABCDEF", vendorHexSource: "manual_label", promotedLabelId: "9", vendorHexPrevious: "#111111", changed: true,
    });
    assert.deepEqual(db.audits, [{
      actor: 3, target: null, action: "shade.vendor_hex_promote",
      changes: { shadeId: "5", labelId: "9", vendorHex: { from: "#111111", to: "#ABCDEF" }, vendorHexSource: { from: "vendor", to: "manual_label" } },
    }]);
  });

  it("is idempotent: a repeat promote changes nothing and writes no audit row", async () => {
    const db = fakeDb({ label: approved, shade: baseShade });
    await promoteManualLabel(db.client, 9, 3);
    const again = await promoteManualLabel(db.client, 9, 3);
    assert.equal(again.body.changed, false);
    assert.equal(db.updates, 1);
    assert.equal(db.audits.length, 1);
  });

  it("re-promoting a re-saved label keeps the original vendor hex for Undo", async () => {
    const db = fakeDb({ label: approved, shade: baseShade });
    await promoteManualLabel(db.client, 9, 3);
    db.label = { ...approved, hex: "#FEDCBA" };
    const result = await promoteManualLabel(db.client, 9, 3);
    assert.equal(result.body.vendorHex, "#FEDCBA");
    assert.equal(result.body.vendorHexPrevious, "#111111");
  });

  it("answers 404 for unknown labels and 409 for unreliable labels or private shades", async () => {
    assert.equal((await promoteManualLabel(fakeDb({ label: approved, shade: baseShade }).client, 10, 3)).status, 404);
    const rejected = fakeDb({ label: { ...approved, hex: null, trainingStatus: "rejected" }, shade: baseShade });
    assert.equal((await promoteManualLabel(rejected.client, 9, 3)).status, 409);
    const privateShade = fakeDb({ label: approved, shade: { ...baseShade, status: "user_submitted" } });
    assert.equal((await promoteManualLabel(privateShade.client, 9, 3)).status, 409);
    assert.equal(privateShade.updates, 0);
  });
});

describe("demote", () => {
  it("restores the previous vendor hex and audits; a second undo is a no-op", async () => {
    const db = fakeDb({ label: approved, shade: baseShade });
    await promoteManualLabel(db.client, 9, 3);
    const undo = await demoteManualLabel(db.client, 9, 3);
    assert.deepEqual(undo.body, {
      shadeId: "5", vendorHex: "#111111", vendorHexSource: "vendor", promotedLabelId: null, vendorHexPrevious: null, changed: true,
    });
    assert.equal(db.audits[1].action, "shade.vendor_hex_demote");
    const again = await demoteShadeVendorHex(db.client, "5", 3);
    assert.equal(again.body.changed, false);
    assert.equal(db.audits.length, 2);
  });

  it("restores no source when the promotion replaced no vendor hex", async () => {
    const db = fakeDb({ label: approved, shade: { ...baseShade, vendorHex: null, vendorHexSource: null } });
    await promoteManualLabel(db.client, 9, 3);
    const undo = await demoteShadeVendorHex(db.client, "5", 3);
    assert.equal(undo.body.vendorHex, null);
    assert.equal(undo.body.vendorHexSource, null);
  });
});
