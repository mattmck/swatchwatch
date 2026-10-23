const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { classifyOutcome, summarize, OUTCOMES } = require("../dist/eval/bottle/scoring");

const CATALOG = { shadeId: 42 };
const EXTERNAL = { shadeId: null };

function candidate(shadeId, overrides = {}) {
  return {
    entityType: "shade",
    entityId: String(shadeId),
    shadeId: String(shadeId),
    display: `Brand Shade ${shadeId}`,
    confidence: 0.9,
    ownership: { relationship: "notOwned" },
    ...overrides,
  };
}

/** A check response; `status` is the stored session status, which check never changes. */
function check(outcome, { match, candidates = [] } = {}) {
  return { status: "processing", outcome, match, candidates: match ? [match, ...candidates] : candidates };
}

function result(overrides = {}) {
  return {
    sampleId: 1,
    brand: "Brand",
    shadeName: "Shade",
    inCatalog: true,
    outcome: "matched_correct",
    status: "matched",
    topEntityId: 42,
    candidateIds: [42],
    frames: 2,
    ms: 100,
    ...overrides,
  };
}

describe("classifyOutcome", () => {
  it("catalog sample matched to its own shade is matched_correct", () => {
    assert.equal(classifyOutcome(CATALOG, check("matched", { match: candidate(42) })), "matched_correct");
  });

  it("catalog sample matched to another shade is matched_wrong", () => {
    assert.equal(classifyOutcome(CATALOG, check("matched", { match: candidate(7) })), "matched_wrong");
  });

  it("catalog sample asked with its shade among the candidates is asked_has_correct", () => {
    const answer = check("needs_question", { candidates: [candidate(7), candidate(42)] });
    assert.equal(classifyOutcome(CATALOG, answer), "asked_has_correct");
  });

  it("catalog sample asked without its shade among the candidates is asked_no_correct", () => {
    const answer = check("needs_question", { candidates: [candidate(7), candidate(8)] });
    assert.equal(classifyOutcome(CATALOG, answer), "asked_no_correct");
  });

  it("catalog sample the resolver could not match is unmatched", () => {
    assert.equal(classifyOutcome(CATALOG, check("unmatched")), "unmatched");
  });

  it("external sample matched to anything is matched_wrong", () => {
    assert.equal(classifyOutcome(EXTERNAL, check("matched", { match: candidate(42) })), "matched_wrong");
  });

  it("external sample asked or unmatched is rejected_correct", () => {
    assert.equal(classifyOutcome(EXTERNAL, check("needs_question", { candidates: [candidate(7)] })), "rejected_correct");
    assert.equal(classifyOutcome(EXTERNAL, check("unmatched")), "rejected_correct");
  });

  it("compares the shade a SKU resolves to, not the SKU id", () => {
    const sku = candidate(42, { entityType: "sku", entityId: "9001", shadeId: "42" });
    assert.equal(classifyOutcome(CATALOG, check("matched", { match: sku })), "matched_correct");
    const asked = check("needs_question", { candidates: [candidate(7, { entityType: "sku", entityId: "9002", shadeId: "42" })] });
    assert.equal(classifyOutcome(CATALOG, asked), "asked_has_correct");
  });

  it("never produces skipped_no_frames or error (the CLI sets those)", () => {
    const produced = new Set();
    for (const sample of [CATALOG, EXTERNAL]) {
      for (const outcome of ["matched", "needs_question", "unmatched"]) {
        for (const shade of [42, 7]) {
          const answer = outcome === "matched"
            ? check(outcome, { match: candidate(shade) })
            : check(outcome, { candidates: outcome === "unmatched" ? [] : [candidate(shade)] });
          produced.add(classifyOutcome(sample, answer));
        }
      }
    }
    assert.ok(!produced.has("skipped_no_frames"));
    assert.ok(!produced.has("error"));
  });
});

describe("summarize", () => {
  it("rates over catalog samples, false-confident count and per-brand counts", () => {
    const summary = summarize([
      result({ sampleId: 1, brand: "Holo Taco", outcome: "matched_correct", ms: 100 }),
      result({ sampleId: 2, brand: "Holo Taco", outcome: "matched_correct", ms: 300 }),
      result({ sampleId: 3, brand: "Cirque Colors", outcome: "matched_wrong", topEntityId: 7, ms: 200 }),
      result({ sampleId: 4, brand: "Indie Brand", inCatalog: false, outcome: "rejected_correct", status: "unmatched", topEntityId: null, candidateIds: [], ms: 400 }),
    ]);
    assert.equal(summary.samples, 4);
    assert.equal(summary.matchRate, 2 / 3);
    assert.equal(summary.askRate, 0);
    assert.equal(summary.falseConfident, 1);
    assert.equal(summary.medianMs, 250);
    assert.equal(summary.byOutcome.matched_correct, 2);
    assert.equal(summary.byOutcome.matched_wrong, 1);
    assert.equal(summary.byOutcome.rejected_correct, 1);
    assert.equal(summary.byOutcome.skipped_no_frames, 0);
    assert.deepEqual(Object.keys(summary.byOutcome).sort(), [...OUTCOMES].sort());
    assert.deepEqual(Object.keys(summary.byBrand).sort(), ["Cirque Colors", "Holo Taco", "Indie Brand"]);
    assert.equal(summary.byBrand["Holo Taco"].matched_correct, 2);
    assert.equal(summary.byBrand["Cirque Colors"].matched_wrong, 1);
    assert.equal(summary.byBrand["Indie Brand"].rejected_correct, 1);
  });

  it("counts both asked outcomes in askRate", () => {
    const summary = summarize([
      result({ outcome: "asked_has_correct" }),
      result({ outcome: "asked_no_correct" }),
      result({ outcome: "unmatched" }),
      result({ outcome: "matched_correct" }),
    ]);
    assert.equal(summary.askRate, 2 / 4);
    assert.equal(summary.matchRate, 1 / 4);
  });

  it("leaves skipped and errored samples out of the rates and the median", () => {
    const summary = summarize([
      result({ outcome: "matched_correct", ms: 50 }),
      result({ outcome: "skipped_no_frames", frames: 0, ms: 0 }),
      result({ outcome: "error", error: "boom", ms: 9000 }),
    ]);
    assert.equal(summary.samples, 3);
    assert.equal(summary.matchRate, 1);
    assert.equal(summary.medianMs, 50);
    assert.equal(summary.byOutcome.skipped_no_frames, 1);
    assert.equal(summary.byOutcome.error, 1);
  });

  it("summarize([]) gives zero rates without dividing by zero", () => {
    const summary = summarize([]);
    assert.equal(summary.samples, 0);
    assert.equal(summary.matchRate, 0);
    assert.equal(summary.askRate, 0);
    assert.equal(summary.falseConfident, 0);
    assert.equal(summary.medianMs, 0);
    assert.deepEqual(summary.byBrand, {});
    assert.ok(Object.values(summary.byOutcome).every((count) => count === 0));
  });
});
