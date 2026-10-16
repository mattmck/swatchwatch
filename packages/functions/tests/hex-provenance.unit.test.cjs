const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// ---------------------------------------------------------------------------
// Mock ../lib/db so applyAiBatchShadeDetections runs without Postgres and we can
// inspect the SQL + parameters it sends.
// ---------------------------------------------------------------------------
let dbCalls = [];
let dbRows = [{ shadeId: 1 }];
const dbPath = path.resolve(__dirname, "../dist/lib/db.js");
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: {
    query: async (sql, params) => {
      dbCalls.push({ sql, params });
      return { rows: dbRows };
    },
    transaction: async (cb) => cb({ query: async () => ({ rows: [] }) }),
  },
};

const {
  resolveDisplayHex,
  resolveDisplayHexDetailed,
  computeHexAgreement,
  normalizeHexColor,
  colorDistance,
  MEDIUM_CONFIDENCE_MAX_DISTANCE,
} = require("swatchwatch-shared");
const {
  provenanceFromDetection,
  provenanceParams,
  normalizeDetectedHexConfidence,
  detectedHexProvenanceSetSql,
  EMPTY_DETECTED_HEX_PROVENANCE,
} = require("../dist/lib/hex-provenance");
const {
  parseVisionHexBatchOutput,
  parseVisionHexBatchDetections,
} = require("../dist/lib/azure-openai-batch");
const {
  PROMPT_VERSION,
  HEX_DETECTION_METHOD_VISION_DIRECT,
  parseHexDetectionContent,
} = require("../dist/lib/ai-color-detection");
const { applyAiBatchShadeDetections } = require("../dist/lib/ingestion-repo");

// ── hex_agreement computation ───────────────────────────────────────────────

describe("computeHexAgreement", () => {
  it("returns null unless both hexes are valid 6-digit colors", () => {
    assert.equal(computeHexAgreement(null, "#FFFFFF"), null);
    assert.equal(computeHexAgreement("#FFFFFF", undefined), null);
    assert.equal(computeHexAgreement("red", "#FFFFFF"), null);
    assert.equal(computeHexAgreement("#FFF", "#FFFFFF"), null);
  });

  it("is the OKLAB distance rounded to the NUMERIC(6,4) precision", () => {
    assert.equal(computeHexAgreement("#000000", "#FFFFFF"), 1);
    assert.equal(computeHexAgreement("#AABBCC", "aabbcc"), 0);
    const raw = colorDistance("#D3D3D3", "#A52A2A");
    assert.equal(computeHexAgreement("#D3D3D3", "#A52A2A"), Math.round(raw * 10000) / 10000);
  });

  it("matches the Postgres hex_oklab_distance() values measured for migration 026", () => {
    // Values returned by `SELECT hex_oklab_distance(a, b)` on Postgres 17 after migration 026.
    assert.equal(computeHexAgreement("#000000", "#FFFFFF"), 1.0);
    assert.equal(computeHexAgreement("#FF0000", "#FE0000"), 0.002);
    assert.equal(computeHexAgreement("#D3D3D3", "#A52A2A"), 0.4179);
  });

  it("normalizeHexColor uppercases and adds the leading #", () => {
    assert.equal(normalizeHexColor(" aabbcc "), "#AABBCC");
    assert.equal(normalizeHexColor("#12ab3F"), "#12AB3F");
    assert.equal(normalizeHexColor("#12ab3"), null);
  });
});

// ── reconciliation ──────────────────────────────────────────────────────────

describe("resolveDisplayHexDetailed", () => {
  it("keeps resolveDisplayHex precedence (vendor > detected > name) by default", () => {
    const cases = [
      { vendorHex: "#111111", detectedHex: "#121212", nameHex: "#131313" },
      { detectedHex: "#121212", nameHex: "#131313" },
      { nameHex: "#131313" },
      {},
    ];
    for (const polish of cases) {
      assert.equal(resolveDisplayHexDetailed(polish).hex, resolveDisplayHex(polish));
    }
    assert.equal(resolveDisplayHexDetailed(cases[0]).source, "vendor");
    assert.equal(resolveDisplayHexDetailed(cases[1]).source, "detected");
    assert.equal(resolveDisplayHexDetailed(cases[2]).source, "name");
    assert.equal(resolveDisplayHexDetailed(cases[3]).source, "none");
  });

  it("does not flag when vendor and detected agree within MEDIUM", () => {
    const r = resolveDisplayHexDetailed({ vendorHex: "#FF0000", detectedHex: "#FE0000" });
    assert.equal(r.flagged, false);
    assert.equal(r.reason, null);
    assert.equal(r.agreement, 0.002);
  });

  it("flags a disagreement above MEDIUM but still shows the vendor hex", () => {
    const r = resolveDisplayHexDetailed({ vendorHex: "#D3D3D3", detectedHex: "#A52A2A" });
    assert.ok(r.agreement > MEDIUM_CONFIDENCE_MAX_DISTANCE);
    assert.equal(r.flagged, true);
    assert.equal(r.reason, "disagreement");
    assert.equal(r.hex, "#D3D3D3");
    assert.equal(r.source, "vendor");
  });

  it("treats a distance exactly at the threshold as agreement", () => {
    const r = resolveDisplayHexDetailed(
      { vendorHex: "#000000", detectedHex: "#FFFFFF", hexAgreement: 0.1 },
      {}
    );
    assert.equal(r.flagged, false);
  });

  it("uses a stored hexAgreement instead of recomputing", () => {
    const r = resolveDisplayHexDetailed({ vendorHex: "#000000", detectedHex: "#000000", hexAgreement: 0.42 });
    assert.equal(r.agreement, 0.42);
    assert.equal(r.flagged, true);
  });

  it("honours a custom disagreement threshold", () => {
    const polish = { vendorHex: "#D3D3D3", detectedHex: "#A52A2A" };
    assert.equal(resolveDisplayHexDetailed(polish, { disagreementThreshold: 0.5 }).flagged, false);
  });

  it("prefers detected over vendor when the caller marks the vendor hex suspicious", () => {
    const r = resolveDisplayHexDetailed(
      { vendorHex: "#D3D3D3", detectedHex: "#7A1F2B", nameHex: "#800000" },
      { vendorHexSuspicious: true }
    );
    assert.equal(r.hex, "#7A1F2B");
    assert.equal(r.source, "detected");
    // Disagreement is still reported so the shade can be reviewed.
    assert.equal(r.reason, "disagreement");
  });

  it("falls back to a suspicious vendor hex when nothing was detected, and flags it", () => {
    const r = resolveDisplayHexDetailed(
      { vendorHex: "#D3D3D3", nameHex: "#800000" },
      { vendorHexSuspicious: true }
    );
    assert.equal(r.hex, "#D3D3D3");
    assert.equal(r.source, "vendor");
    assert.equal(r.flagged, true);
    assert.equal(r.reason, "vendor-suspicious");
    assert.equal(r.agreement, null);
  });

  it("suspicious flag without a vendor hex changes nothing", () => {
    const r = resolveDisplayHexDetailed({ detectedHex: "#123456" }, { vendorHexSuspicious: true });
    assert.equal(r.source, "detected");
    assert.equal(r.flagged, false);
  });
});

// ── provenance helpers ──────────────────────────────────────────────────────

describe("hex-provenance helpers", () => {
  it("normalizes confidence to 0..1 with 3 decimals", () => {
    assert.equal(normalizeDetectedHexConfidence(0.87654), 0.877);
    assert.equal(normalizeDetectedHexConfidence(1.4), 1);
    assert.equal(normalizeDetectedHexConfidence(-2), 0);
    assert.equal(normalizeDetectedHexConfidence(Number.NaN), null);
    assert.equal(normalizeDetectedHexConfidence("0.5"), null);
  });

  it("maps a detection result to the column values in parameter order", () => {
    const p = provenanceFromDetection({
      confidence: 0.91234,
      method: "vision-direct",
      model: " gpt-4o-mini ",
      promptVersion: PROMPT_VERSION,
    });
    assert.deepEqual(provenanceParams(p), [0.912, "vision-direct", "gpt-4o-mini", PROMPT_VERSION]);
    assert.deepEqual(provenanceFromDetection(null), { ...EMPTY_DETECTED_HEX_PROVENANCE });
  });

  it("builds SET clauses gated on the applied condition with consecutive params", () => {
    const sql = detectedHexProvenanceSetSql("COND", 9, "sh.");
    assert.match(sql, /detected_hex_confidence = CASE WHEN \(COND\) THEN \$9::numeric ELSE sh\.detected_hex_confidence END/);
    assert.match(sql, /detected_hex_method = CASE WHEN \(COND\) THEN \$10::text/);
    assert.match(sql, /detected_hex_model = CASE WHEN \(COND\) THEN \$11::text/);
    assert.match(sql, /detected_hex_prompt_version = CASE WHEN \(COND\) THEN \$12::text/);
    assert.match(sql, /detected_hex_at = CASE WHEN \(COND\) THEN now\(\) ELSE sh\.detected_hex_at END/);
    // hex_agreement is generated by Postgres and must never be assigned.
    assert.doesNotMatch(sql, /hex_agreement/);
  });

  it("parseHexDetectionContent stamps method and prompt version", async () => {
    const r = await parseHexDetectionContent('{"hex":"#aabbcc","confidence":0.7}', "test");
    assert.equal(r.method, HEX_DETECTION_METHOD_VISION_DIRECT);
    assert.equal(r.promptVersion, PROMPT_VERSION);
  });
});

// ── batch result threading ──────────────────────────────────────────────────

function outputLine(customId, content, model) {
  return JSON.stringify({
    custom_id: customId,
    response: {
      status_code: 200,
      body: { model, choices: [{ message: { content } }] },
    },
  });
}

describe("batch result provenance threading", () => {
  it("parseVisionHexBatchOutput captures the echoed model id", () => {
    const rows = parseVisionHexBatchOutput(outputLine("ext-1", '{"hex":"#112233"}', "gpt-4o-mini-2024-07-18"));
    assert.equal(rows[0].model, "gpt-4o-mini-2024-07-18");
  });

  it("stamps detections with the submission deployment and prompt version", async () => {
    const rows = parseVisionHexBatchOutput(
      [
        outputLine("ext-1", '{"hex":"#112233","confidence":0.8}', "gpt-4o-mini-2024-07-18"),
        JSON.stringify({ custom_id: "ext-2", error: { message: "boom" } }),
      ].join("\n")
    );
    const detections = await parseVisionHexBatchDetections(rows, {
      deployment: "hex-batch-deploy",
      promptVersion: "vision-direct/old",
    });
    assert.equal(detections[0].detection.hex, "#112233");
    assert.equal(detections[0].detection.confidence, 0.8);
    assert.equal(detections[0].detection.method, "vision-direct");
    assert.equal(detections[0].detection.model, "hex-batch-deploy");
    assert.equal(detections[0].detection.promptVersion, "vision-direct/old");
    assert.equal(detections[1].detection, null);
  });

  it("falls back to the echoed model and current PROMPT_VERSION for older jobs", async () => {
    const rows = parseVisionHexBatchOutput(outputLine("ext-1", '{"hex":"#112233"}', "gpt-4o-mini"));
    const [d] = await parseVisionHexBatchDetections(rows);
    assert.equal(d.detection.model, "gpt-4o-mini");
    assert.equal(d.detection.promptVersion, PROMPT_VERSION);
  });
});

describe("applyAiBatchShadeDetections — provenance write", () => {
  beforeEach(() => {
    dbCalls = [];
    dbRows = [{ shadeId: 1 }];
  });

  it("writes provenance params after the overwrite flag and gates them like detected_hex", async () => {
    const metrics = await applyAiBatchShadeDetections(
      7,
      [
        {
          externalId: "ext-1",
          detectedHex: "#112233",
          detectedFinishes: ["creme"],
          provenance: provenanceFromDetection({
            confidence: 0.8,
            method: "vision-direct",
            model: "hex-batch-deploy",
            promptVersion: "vision-direct/old",
          }),
        },
      ],
      false
    );
    assert.equal(metrics.applied, 1);
    assert.equal(dbCalls.length, 1);
    const { sql, params } = dbCalls[0];
    assert.deepEqual(params, [7, "ext-1", "#112233", ["creme"], false, 0.8, "vision-direct", "hex-batch-deploy", "vision-direct/old"]);
    // Non-overwrite: provenance only lands when detected_hex was NULL before.
    assert.match(sql, /\(\$5::boolean AND \$3::text IS NOT NULL\) OR \(sh\.detected_hex IS NULL AND \$3::text IS NOT NULL\)/);
    assert.match(sql, /detected_hex_confidence = CASE WHEN .* THEN \$6::numeric/);
    assert.doesNotMatch(sql, /hex_agreement\s*=/);
  });

  it("sends null provenance when a detection carries none", async () => {
    await applyAiBatchShadeDetections(
      7,
      [{ externalId: "ext-1", detectedHex: "#112233", detectedFinishes: null }],
      true
    );
    assert.deepEqual(dbCalls[0].params.slice(5), [null, null, null, null]);
  });
});
