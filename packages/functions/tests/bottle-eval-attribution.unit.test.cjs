const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { attributeFailure, resolverTraceFromStatus } = require("../dist/eval/bottle/attribution");
const { classifyOutcome, summarize, FAILURE_STAGES } = require("../dist/eval/bottle/scoring");
const { formatSummary } = require("../dist/eval/bottle/report");
const { runSample } = require("../dist/eval/bottle/cli");
const { labelPoolEligibility, toEvalSamples, SELECT_EVAL_SAMPLES_SQL } = require("../dist/eval/bottle/samples");

/** Labelled catalog bottle: shade 42 of brand 7 ("Holo Taco"), eligible for the pool. */
const LABEL = { shadeId: 42, brand: "Holo Taco", brandId: 7, labelPoolEligible: true };
const EXTERNAL = { shadeId: null, brand: "Indie", brandId: null, labelPoolEligible: null };

function candidate(shadeId) {
  return {
    entityType: "shade",
    entityId: String(shadeId),
    shadeId: String(shadeId),
    display: `Shade ${shadeId}`,
    confidence: 0.8,
    ownership: { relationship: "notOwned" },
  };
}

function check(outcome, ids = []) {
  const candidates = ids.map(candidate);
  return { status: "processing", outcome, candidates, ...(outcome === "matched" ? { match: candidates[0] } : {}) };
}

function top(shadeId, nameScore, colorDistance = null) {
  return { shadeId, brandId: 7, display: `Shade ${shadeId}`, nameScore, colorDistance, colorScore: null, score: nameScore ?? 0, fromConflictBrand: false };
}

/** A capture status read whose `metadata.resolver` is what `resolveBottle` stores. */
function status({
  step = "needs_user_candidate_selection",
  brand = { brandId: "7", name: "Holo Taco", source: "read" },
  top5 = [],
  evidence = {},
  brandConflict,
  version = "bottle-v1",
} = {}) {
  return {
    captureId: "c",
    status: "processing",
    metadata: {
      resolver: {
        version,
        step,
        brand,
        top5,
        candidateCount: top5.length,
        modelCalls: 2,
        ...(brandConflict ? { brandConflict } : {}),
        audit: {
          version,
          evidence: { brand: brand?.name ?? null, brandRead: null, shadeName: "Read Name", shadeNameListed: null, glassHex: "#aa0000", ...evidence },
          thresholds: { match: 0.92, question: 0.75, createCard: 0.5, colorHigh: 0.05, colorMedium: 0.1 },
        },
      },
    },
  };
}

/** Score a sample end to end the way the CLI does. */
function attribute(sample, answer, statusRead) {
  const outcome = classifyOutcome(sample, answer);
  return { outcome, ...attributeFailure(sample, outcome, answer, resolverTraceFromStatus(statusRead)) };
}

describe("attributeFailure", () => {
  it("gives no stage to matched_correct, skipped and errored samples", () => {
    const answer = check("matched", [42]);
    assert.equal(attributeFailure(LABEL, "matched_correct", answer, resolverTraceFromStatus(status({ step: "matched_by_name" }))), null);
    assert.equal(attributeFailure(LABEL, "skipped_no_frames", answer, null), null);
    assert.equal(attributeFailure(LABEL, "error", answer, null), null);
  });

  it("barcode_wrong_shade: the barcode matched another shade", () => {
    const got = attribute(LABEL, check("matched", [9]), status({ step: "matched_by_barcode", version: "deterministic-v1" }));
    assert.equal(got.outcome, "matched_wrong");
    assert.equal(got.stage, "barcode_wrong_shade");
  });

  it("barcode_wrong_shade also for a not-in-catalog bottle the barcode matched", () => {
    const got = attribute(EXTERNAL, check("matched", [9]), status({ step: "matched_by_barcode" }));
    assert.equal(got.stage, "barcode_wrong_shade");
  });

  it("brand_not_read: no brand text from any source", () => {
    const got = attribute(LABEL, check("needs_question", [9]), status({ step: "needs_brand_and_shade", brand: null, evidence: { brand: null } }));
    assert.equal(got.stage, "brand_not_read");
  });

  it("brand_not_in_catalog: brand text that did not resolve to a catalog brand", () => {
    const got = attribute(
      LABEL,
      check("needs_question", [9]),
      status({ step: "needs_brand_and_shade", brand: null, evidence: { brand: null, brandRead: { text: "H0lo Tac", confidence: 0.4, source: "pipeline" } } })
    );
    assert.equal(got.stage, "brand_not_in_catalog");
    assert.match(got.detail, /H0lo Tac/);
  });

  it("brand_wrong: a catalog brand that is not the label's", () => {
    const got = attribute(LABEL, check("matched", [9]), status({ step: "matched_by_name", brand: { brandId: "8", name: "Cirque Colors", source: "read" }, top5: [top(9, 0.95)] }));
    assert.equal(got.stage, "brand_wrong");
  });

  it("a conflicting read brand that joined the pool counts as the right brand", () => {
    const got = attribute(
      LABEL,
      check("needs_question", [9, 42]),
      status({
        brand: { brandId: "8", name: "Cirque Colors", source: "hint" },
        brandConflict: { hinted: { brandId: "8", name: "Cirque Colors", source: "hint" }, read: { brandId: "7", name: "Holo Taco", source: "read" } },
        top5: [top(9, 0.8), top(42, 0.7)],
      })
    );
    assert.equal(got.stage, "name_ambiguous");
  });

  it("compares brand names when the label's brand id is unknown", () => {
    const sample = { ...LABEL, brandId: null };
    const answer = check("needs_question", [9]);
    assert.equal(attribute(sample, answer, status({ top5: [top(9, 0.8)] })).stage, "name_wrong");
    assert.equal(attribute({ ...sample, brand: "Other" }, answer, status({ top5: [top(9, 0.8)] })).stage, "brand_wrong");
  });

  it("candidate_pool_missing_label: the labelled shade cannot be in the pool", () => {
    const got = attribute({ ...LABEL, labelPoolEligible: false }, check("needs_question", [9]), status({ top5: [top(9, 0.8)] }));
    assert.equal(got.stage, "candidate_pool_missing_label");
  });

  it("name_not_read: right brand, no printed or listed name", () => {
    const got = attribute(LABEL, check("needs_question", [9, 42]), status({ top5: [top(9, null, 0.02), top(42, null, 0.04)], evidence: { shadeName: null } }));
    assert.equal(got.outcome, "asked_has_correct");
    assert.equal(got.stage, "name_not_read");
  });

  it("name_wrong: a name was read but the label is not in the top five", () => {
    const got = attribute(LABEL, check("needs_question", [9, 10]), status({ top5: [top(9, 0.8), top(10, 0.78)] }));
    assert.equal(got.outcome, "asked_no_correct");
    assert.equal(got.stage, "name_wrong");
  });

  it("name_wrong: another shade was matched on a better name score", () => {
    const got = attribute(LABEL, check("matched", [9, 42]), status({ step: "matched_by_name", top5: [top(9, 0.95, 0.02), top(42, 0.7, 0.01)] }));
    assert.equal(got.outcome, "matched_wrong");
    assert.equal(got.stage, "name_wrong");
  });

  it("name_ambiguous: the label is a candidate but another shade's name scored higher", () => {
    const got = attribute(LABEL, check("needs_question", [9, 42]), status({ top5: [top(9, 0.8, 0.2), top(42, 0.78, 0.01)] }));
    assert.equal(got.outcome, "asked_has_correct");
    assert.equal(got.stage, "name_ambiguous");
  });

  it("name_weak: the label ranked first but its name scored under the question band", () => {
    const answer = { status: "processing", outcome: "unmatched", candidates: [] };
    const got = attribute(LABEL, answer, status({ step: "create_card", top5: [top(42, 0.4, 0.2)] }));
    assert.equal(got.outcome, "unmatched");
    assert.equal(got.stage, "name_weak");
  });

  it("color_no_hex: a question-band name color could not confirm (no distance)", () => {
    const got = attribute(LABEL, check("needs_question", [42]), status({ top5: [top(42, 0.8, null)], evidence: { glassHex: null } }));
    assert.equal(got.stage, "color_no_hex");
  });

  it("color_not_confirmed: a question-band name with the glass color outside the confirm band", () => {
    const got = attribute(LABEL, check("needs_question", [42]), status({ top5: [top(42, 0.8, 0.08)] }));
    assert.equal(got.stage, "color_not_confirmed");
  });

  it("color_vetoed: a match-band name the glass color rejected", () => {
    const got = attribute(LABEL, check("needs_question", [42, 9]), status({ top5: [top(42, 0.95, 0.2), top(9, 0.6, 0.01)] }));
    assert.equal(got.stage, "color_vetoed");
  });

  it("color_tie_broke_wrong: a name tie ordered by color put another shade first", () => {
    const got = attribute(LABEL, check("matched", [9, 42]), status({ step: "matched_by_name", top5: [top(9, 1, 0.03), top(42, 1, 0.06)] }));
    assert.equal(got.outcome, "matched_wrong");
    assert.equal(got.stage, "color_tie_broke_wrong");
  });

  it("color_no_hex: a name tie where the label had no color distance", () => {
    const got = attribute(LABEL, check("needs_question", [9, 42]), status({ top5: [top(9, 0.8, 0.03), top(42, 0.8, null)] }));
    assert.equal(got.stage, "color_no_hex");
  });

  it("label_not_in_catalog_expected for a correctly rejected bottle", () => {
    const got = attribute(EXTERNAL, { status: "processing", outcome: "unmatched", candidates: [] }, status({ step: "create_card" }));
    assert.equal(got.outcome, "rejected_correct");
    assert.equal(got.stage, "label_not_in_catalog_expected");
  });

  it("false_match_not_in_catalog for a not-in-catalog bottle matched by name", () => {
    const got = attribute(EXTERNAL, check("matched", [9]), status({ step: "matched_by_name", top5: [top(9, 0.95)] }));
    assert.equal(got.outcome, "matched_wrong");
    assert.equal(got.stage, "false_match_not_in_catalog");
  });

  it("unknown without a resolver audit, for a non-bottle-v1 audit, or when the audit disagrees with the check", () => {
    const answer = check("needs_question", [9]);
    assert.equal(attribute(LABEL, answer, null).stage, "unknown");
    assert.equal(attribute(LABEL, answer, { captureId: "c", status: "processing" }).stage, "unknown");
    assert.equal(attribute(LABEL, answer, status({ version: "deterministic-v1", top5: [top(9, 0.8)] })).stage, "unknown");
    const stale = attribute(LABEL, answer, status({ step: "matched_by_name", top5: [top(9, 0.95)] }));
    assert.equal(stale.stage, "unknown");
    assert.match(stale.detail, /disagrees/);
  });

  it("every stage is listed in FAILURE_STAGES", () => {
    assert.equal(new Set(FAILURE_STAGES).size, FAILURE_STAGES.length);
    for (const stage of ["barcode_wrong_shade", "brand_not_read", "candidate_pool_missing_label", "color_tie_broke_wrong", "unknown"]) {
      assert.ok(FAILURE_STAGES.includes(stage), stage);
    }
  });
});

describe("label pool eligibility", () => {
  const row = (overrides) => ({ sampleId: "1", shadeId: "42", brand: "B", shadeName: "S", labelBrandId: "7", labelStatus: "active", labelCategory: "color", labelMergedIntoShadeId: null, ...overrides });

  it("is true for an active color shade, false for merged / excluded / non-color, null when unknown", () => {
    assert.equal(labelPoolEligibility(row({})), true);
    assert.equal(labelPoolEligibility(row({ labelMergedIntoShadeId: "5" })), false);
    assert.equal(labelPoolEligibility(row({ labelStatus: "excluded" })), false);
    assert.equal(labelPoolEligibility(row({ labelCategory: "topper" })), false);
    assert.equal(labelPoolEligibility(row({ labelStatus: "user_submitted" })), null);
    assert.equal(labelPoolEligibility(row({ shadeId: null, labelStatus: null })), null);
  });

  it("toEvalSamples carries the label brand id and eligibility; the SQL joins the label shade", () => {
    const [sample] = toEvalSamples([row({})], []);
    assert.equal(sample.brandId, 7);
    assert.equal(sample.labelPoolEligible, true);
    assert.match(SELECT_EVAL_SAMPLES_SQL, /LEFT JOIN shade label ON label\.shade_id = sample\."shadeId"::bigint/);
  });
});

describe("runSample attribution", () => {
  it("attributes from the status read and keeps the stage in the result", async () => {
    const api = {
      async start() {
        return { captureId: "c1", status: "processing" };
      },
      async frame() {
        return { received: true, captureId: "c1", frameId: "1", status: "processing" };
      },
      async check() {
        return check("needs_question", [9, 42]);
      },
      async status() {
        return status({ top5: [top(9, 0.8), top(42, 0.7)] });
      },
    };
    const sample = { sampleId: 3, ...LABEL, shadeName: "S", finishFamily: "holo", frames: [{ frameId: 1, surface: "bottom", frameType: "label", storageUrl: "u" }] };
    const result = await runSample(api, sample, async () => "data:image/jpeg;base64,AA==");
    assert.equal(result.outcome, "asked_has_correct");
    assert.equal(result.failureStage, "name_ambiguous");
    assert.match(result.failureDetail, /label #2/);
  });

  it("leaves the stage unknown when the status read fails", async () => {
    const api = {
      async start() {
        return { captureId: "c1", status: "processing" };
      },
      async frame() {
        return { received: true, captureId: "c1", frameId: "1", status: "processing" };
      },
      async check() {
        return check("needs_question", [9]);
      },
      async status() {
        throw new Error("500");
      },
    };
    const sample = { sampleId: 3, ...LABEL, shadeName: "S", finishFamily: "holo", frames: [{ frameId: 1, surface: "bottom", frameType: "label", storageUrl: "u" }] };
    const result = await runSample(api, sample, async () => "data:image/jpeg;base64,AA==");
    assert.equal(result.failureStage, "unknown");
    assert.equal(result.modelCalls, null);
  });
});

describe("failure stage summary and report", () => {
  const base = { shadeName: "S", inCatalog: true, status: "needs_question", topEntityId: 9, candidateIds: [9], frames: 3, ms: 100, finishFamily: "solid", modelCalls: 2, promptsFollowed: 3, adaptive: true, createCard: false };
  const results = [
    { ...base, sampleId: 1, brand: "Holo Taco", outcome: "matched_correct", failureStage: null },
    { ...base, sampleId: 2, brand: "Holo Taco", outcome: "asked_has_correct", failureStage: "name_ambiguous", failureDetail: "label #2" },
    { ...base, sampleId: 3, brand: "Holo Taco", outcome: "matched_wrong", failureStage: "color_tie_broke_wrong" },
    { ...base, sampleId: 4, brand: "Cirque Colors", outcome: "unmatched", failureStage: "brand_not_read" },
    { ...base, sampleId: 5, brand: "Cirque Colors", outcome: "error", failureStage: null, error: "boom" },
  ];

  it("counts stages in total and per brand, skipping null stages", () => {
    const summary = summarize(results);
    assert.equal(summary.byFailureStage.name_ambiguous, 1);
    assert.equal(summary.byFailureStage.color_tie_broke_wrong, 1);
    assert.equal(summary.byFailureStage.brand_not_read, 1);
    assert.equal(Object.values(summary.byFailureStage).reduce((a, b) => a + b, 0), 3);
    assert.equal(summary.byBrandFailureStage["Holo Taco"].name_ambiguous, 1);
    assert.equal(summary.byBrandFailureStage["Cirque Colors"].brand_not_read, 1);
    assert.equal(summarize([]).byFailureStage.unknown, 0);
  });

  it("prints only the stages that occurred, per brand, and the stage per sample when verbose", () => {
    const text = formatSummary(summarize(results), results, true);
    assert.match(text, /Failure stages \(earliest stage that lost each sample; 3 sample\(s\)\):/);
    assert.match(text, /name_ambiguous\s+1\n/);
    assert.ok(!text.includes("barcode_wrong_shade"));
    assert.match(text, /\bstage\b/);
    assert.match(text, /label #2/);
    assert.match(text, /boom/);
    const quiet = formatSummary(summarize([results[0]]), [results[0]], false);
    assert.ok(!quiet.includes("Failure stages"));
  });
});
