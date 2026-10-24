/**
 * Brand-first bottle resolver (Bottle Flow slice A, spec 5.3): scoring, the decision table and
 * `resolveBottle` with recorder deps. Runs without a database: the module takes its query,
 * brand lookup, global candidates and color distances as arguments.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  BOTTLE_RESOLVER_VERSION,
  BOTTLE_RESOLVER_THRESHOLDS,
  COLOR_SCORE_BREAKPOINTS,
  BOTTLE_CANDIDATES_SQL,
  colorScoreForDistance,
  scoreBottleCandidates,
  decideBottleResolution,
  buildSuggestedShade,
  hintBrandFromMetadata,
  sumFrameModelCalls,
  visionConfidenceFromFrames,
  resolveBottle,
  loadColorDistances,
} = require("../dist/lib/bottle-resolver");

const USER = 77;

describe("lib/bottle-resolver — constants", () => {
  it("version and thresholds", () => {
    assert.equal(BOTTLE_RESOLVER_VERSION, "bottle-v1");
    assert.deepEqual({ ...BOTTLE_RESOLVER_THRESHOLDS }, {
      match: 0.92,
      question: 0.75,
      createCard: 0.5,
      colorHigh: 0.05,
      colorMedium: 0.1,
      brandRead: 0.6,
      brandConflict: 0.8,
      maxCandidates: 5,
      poolLimit: 50,
    });
    assert.deepEqual(COLOR_SCORE_BREAKPOINTS.map((p) => [...p]), [[0, 1], [0.05, 0.75], [0.1, 0.25], [0.3, 0]]);
  });
});

describe("lib/bottle-resolver — colorScoreForDistance", () => {
  it("piecewise linear through the breakpoints", () => {
    assert.equal(colorScoreForDistance(0), 1);
    assert.equal(colorScoreForDistance(0.05), 0.75);
    assert.equal(colorScoreForDistance(0.1), 0.25);
    assert.equal(colorScoreForDistance(0.2), 0.125);
    assert.equal(colorScoreForDistance(0.5), 0);
    assert.equal(colorScoreForDistance(null), null);
  });
  it("interpolates between breakpoints and clamps below zero", () => {
    assert.ok(Math.abs(colorScoreForDistance(0.025) - 0.875) < 1e-9);
    assert.equal(colorScoreForDistance(-0.01), 1);
    assert.equal(colorScoreForDistance(0.3), 0);
  });
});

const row = (shadeId, shadeName, over = {}) => ({
  shadeId: String(shadeId),
  brandId: "3",
  brand: "Loud Lacquer",
  shadeName,
  nameScore: null,
  colorDistance: null,
  ...over,
});

describe("lib/bottle-resolver — scoreBottleCandidates", () => {
  it("lifts the listed-name row to the vision confidence when the trigram is lower", () => {
    const scored = scoreBottleCandidates(
      [row(1, "Unicorn Skin", { nameScore: 0.4 }), row(2, "Other", { nameScore: 0.3 })],
      { shadeNameListed: "unicorn skin", visionConfidence: 0.85, hintBrandId: 3 }
    );
    assert.equal(scored[0].shadeId, 1);
    assert.equal(scored[0].nameScore, 0.85);
    assert.equal(scored[0].score, 0.85);
    assert.equal(scored[0].display, "Loud Lacquer — Unicorn Skin");
    assert.equal(scored[1].nameScore, 0.3);
  });
  it("keeps a higher trigram over the vision confidence", () => {
    const scored = scoreBottleCandidates([row(1, "Unicorn Skin", { nameScore: 0.95 })], {
      shadeNameListed: "Unicorn Skin",
      visionConfidence: 0.8,
      hintBrandId: null,
    });
    assert.equal(scored[0].nameScore, 0.95);
  });
  it("orders nameScore DESC with nulls last, then colorDistance ASC nulls last, then shade id", () => {
    const scored = scoreBottleCandidates(
      [
        row(5, "A", { nameScore: null, colorDistance: 0.02 }),
        row(4, "B", { nameScore: 0.3, colorDistance: 0.5 }),
        row(3, "C", { nameScore: 0.3, colorDistance: 0.1 }),
        row(2, "D", { nameScore: 0.3, colorDistance: null }),
        row(1, "E", { nameScore: 0.3, colorDistance: null }),
      ],
      { shadeNameListed: null, visionConfidence: null, hintBrandId: null }
    );
    assert.deepEqual(scored.map((c) => c.shadeId), [3, 4, 1, 2, 5]);
  });
  it("score is nameScore, else colorScore, else 0", () => {
    const scored = scoreBottleCandidates(
      [row(1, "A", { colorDistance: 0.05 }), row(2, "B"), row(3, "C", { nameScore: 0.6, colorDistance: 0.05 })],
      { shadeNameListed: null, visionConfidence: null, hintBrandId: null }
    );
    const byId = Object.fromEntries(scored.map((c) => [c.shadeId, c]));
    assert.equal(byId[3].score, 0.6);
    assert.equal(byId[1].score, 0.75);
    assert.equal(byId[1].colorScore, 0.75);
    assert.equal(byId[2].score, 0);
    assert.equal(byId[2].colorScore, null);
  });
  it("fromConflictBrand is true only for rows of another brand when a hint brand is set", () => {
    const rows = [row(1, "A", { nameScore: 0.5 }), row(2, "B", { brandId: "7", nameScore: 0.4 })];
    const withHint = scoreBottleCandidates(rows, { shadeNameListed: null, visionConfidence: null, hintBrandId: 3 });
    assert.deepEqual(withHint.map((c) => [c.shadeId, c.brandId, c.fromConflictBrand]), [[1, 3, false], [2, 7, true]]);
    const noHint = scoreBottleCandidates(rows, { shadeNameListed: null, visionConfidence: null, hintBrandId: null });
    assert.ok(noHint.every((c) => c.fromConflictBrand === false));
  });
});

const cand = (shadeId, nameScore, colorDistance = null, over = {}) => ({
  shadeId,
  brandId: 3,
  display: `Brand — Shade ${shadeId}`,
  nameScore,
  colorDistance,
  colorScore: colorScoreForDistance(colorDistance),
  score: nameScore ?? colorScoreForDistance(colorDistance) ?? 0,
  fromConflictBrand: false,
  ...over,
});
const known = { nameRead: true, brandKnown: true };
const unknownBrand = { nameRead: true, brandKnown: false };

describe("lib/bottle-resolver — decideBottleResolution (spec 5.3 bands)", () => {
  it("name >= 0.92 with color within MEDIUM matches by name", () => {
    const d = decideBottleResolution([cand(1, 0.95, 0.03)], known);
    assert.equal(d.kind, "matched");
    assert.equal(d.method, "name");
    assert.equal(d.confidence, 0.95);
    assert.equal(d.candidate.shadeId, 1);
  });
  it("name >= 0.92 with no glass hex matches by name", () => {
    const d = decideBottleResolution([cand(1, 0.93, null)], known);
    assert.equal(d.kind, "matched");
    assert.equal(d.confidence, 0.93);
  });
  it("name >= 0.92 with color beyond MEDIUM never auto-matches", () => {
    const d = decideBottleResolution([cand(1, 0.95, 0.2)], known);
    assert.equal(d.kind, "candidates");
    assert.equal(d.method, "name");
    assert.equal(d.tie, false);
    assert.equal(d.confidence, 0.95);
  });
  it("name >= 0.92 at exactly MEDIUM still matches", () => {
    assert.equal(decideBottleResolution([cand(1, 0.95, 0.1)], known).kind, "matched");
  });
  it("0.75 <= name < 0.92 with color within HIGH matches name+color at 0.92", () => {
    const d = decideBottleResolution([cand(1, 0.8, 0.04)], known);
    assert.equal(d.kind, "matched");
    assert.equal(d.method, "name+color");
    assert.equal(d.confidence, 0.92);
  });
  it("0.75 <= name < 0.92 with color between HIGH and MEDIUM asks", () => {
    const d = decideBottleResolution([cand(1, 0.8, 0.08)], known);
    assert.equal(d.kind, "candidates");
    assert.equal(d.method, "name");
    assert.equal(d.confidence, 0.8);
  });
  it("0.75 <= name < 0.92 without a glass hex asks", () => {
    assert.equal(decideBottleResolution([cand(1, 0.8, null)], known).kind, "candidates");
  });
  it("no name read: color within MEDIUM lists candidates by color, tie when the second is also close", () => {
    const d = decideBottleResolution([cand(1, null, 0.04), cand(2, null, 0.09)], { nameRead: false, brandKnown: true });
    assert.equal(d.kind, "candidates");
    assert.equal(d.method, "color");
    assert.equal(d.tie, true);
    assert.equal(d.confidence, colorScoreForDistance(0.04));
  });
  it("no name read: a far second candidate is not a tie", () => {
    const d = decideBottleResolution([cand(1, null, 0.04), cand(2, null, 0.2)], { nameRead: false, brandKnown: true });
    assert.equal(d.kind, "candidates");
    assert.equal(d.tie, false);
  });
  it("color-only never auto-matches, even at distance 0", () => {
    const d = decideBottleResolution([cand(1, null, 0)], { nameRead: false, brandKnown: true });
    assert.equal(d.kind, "candidates");
  });
  it("no name read, color beyond MEDIUM: create card when the brand is known", () => {
    const d = decideBottleResolution([cand(1, null, 0.15)], { nameRead: false, brandKnown: true });
    assert.deepEqual(d, { kind: "create_card", confidence: 0 });
  });
  it("no name read, no usable color, unknown brand: unmatched", () => {
    assert.equal(decideBottleResolution([cand(1, null, null)], { nameRead: false, brandKnown: false }).kind, "unmatched");
    assert.equal(decideBottleResolution([cand(1, null, 0.15)], { nameRead: false, brandKnown: false }).kind, "unmatched");
  });
  it("0.5 <= name < 0.75 lists candidates by name even without color", () => {
    const d = decideBottleResolution([cand(1, 0.6, null)], known);
    assert.equal(d.kind, "candidates");
    assert.equal(d.method, "name");
    assert.equal(d.confidence, 0.6);
  });
  it("name below 0.5 with a known brand: create card", () => {
    assert.deepEqual(decideBottleResolution([cand(1, 0.4)], known), { kind: "create_card", confidence: 0 });
  });
  it("name below 0.5 with an unknown brand: unmatched with the top score", () => {
    const d = decideBottleResolution([cand(1, 0.4)], unknownBrand);
    assert.deepEqual(d, { kind: "unmatched", confidence: 0.4 });
  });
  it("a name read with a null name score falls through to the create card / unmatched rows", () => {
    assert.equal(decideBottleResolution([cand(1, null, 0.01)], known).kind, "create_card");
    assert.equal(decideBottleResolution([cand(1, null, 0.01)], unknownBrand).kind, "unmatched");
  });
  it("no candidates: create card when the brand is known, else unmatched at 0", () => {
    assert.deepEqual(decideBottleResolution([], known), { kind: "create_card", confidence: 0 });
    assert.deepEqual(decideBottleResolution([], unknownBrand), { kind: "unmatched", confidence: 0 });
  });
  it("candidate lists are cut to 5", () => {
    const seven = [1, 2, 3, 4, 5, 6, 7].map((id) => cand(id, 0.8, null));
    const d = decideBottleResolution(seven, known);
    assert.equal(d.kind, "candidates");
    assert.equal(d.candidates.length, 5);
    const colorSeven = [1, 2, 3, 4, 5, 6, 7].map((id) => cand(id, null, 0.05));
    const c = decideBottleResolution(colorSeven, { nameRead: false, brandKnown: true });
    assert.equal(c.candidates.length, 5);
  });
});

const baseEvidence = (over = {}) => ({ surfaces: {}, skippedSurfaces: [], ...over });
const hint = (brandId = "3", name = "Loud Lacquer") => ({ brandId, name, source: "hint" });

describe("lib/bottle-resolver — buildSuggestedShade", () => {
  it("copies the evidence and the brand", () => {
    const suggested = buildSuggestedShade(
      baseEvidence({ shadeName: "Unicorn Skin", glassHex: "#B4004E", finish: "holo", gtin: "0123456789012" }),
      { brandId: "3", name: "Loud Lacquer", source: "read" }
    );
    assert.deepEqual(suggested, {
      brandId: "3",
      brandName: "Loud Lacquer",
      brandSource: "read",
      shadeName: "Unicorn Skin",
      hex: "#B4004E",
      finish: "holo",
      gtin: "0123456789012",
    });
  });
  it("nulls for everything missing", () => {
    assert.deepEqual(buildSuggestedShade(baseEvidence(), null), {
      brandId: null, brandName: null, brandSource: null, shadeName: null, hex: null, finish: null, gtin: null,
    });
  });
});

describe("lib/bottle-resolver — session helpers", () => {
  it("hintBrandFromMetadata reads metadata.bottle.brand without the raw text", () => {
    assert.deepEqual(
      hintBrandFromMetadata({ bottle: { brand: { brandId: "3", name: "Loud Lacquer", source: "hint", raw: "loud" } } }),
      { brandId: "3", name: "Loud Lacquer", source: "hint" }
    );
    assert.deepEqual(
      hintBrandFromMetadata({ bottle: { brand: { brandId: null, name: "loud", source: "hint", raw: "loud" } } }),
      { brandId: null, name: "loud", source: "hint" }
    );
    assert.equal(hintBrandFromMetadata({}), null);
    assert.equal(hintBrandFromMetadata(null), null);
    assert.equal(hintBrandFromMetadata({ bottle: { brand: { name: "" } } }), null);
  });
  it("sumFrameModelCalls adds the glass and sticker calls of every frame", () => {
    const frames = [
      { frameType: "label", quality: { ai: { sticker: { modelCalls: 1 } } } },
      { frameType: "color", quality: { ai: { glass: { modelCalls: 1 } } } },
      { frameType: "label", quality: { ai: { sticker: { modelCalls: 0 }, glass: { modelCalls: 1 } } } },
      { frameType: "label", quality: null },
      { frameType: "label", quality: { ai: { sticker: { modelCalls: "x" } } } },
    ];
    assert.equal(sumFrameModelCalls(frames), 3);
  });
  it("visionConfidenceFromFrames takes the sticker confidence of the newest frame with a listed pick", () => {
    const frames = [
      { frameType: "label", quality: { extracted: { brand: "x" }, ai: { sticker: { confidence: 0.2 } } } },
      { frameType: "label", quality: { extracted: { shadeNameListed: "A" }, ai: { sticker: { confidence: 0.81 } } } },
      { frameType: "label", quality: { extracted: { shadeNameListed: "A" }, ai: { sticker: { confidence: 0.5 } } } },
    ];
    assert.equal(visionConfidenceFromFrames(frames), 0.81);
    assert.equal(visionConfidenceFromFrames([]), null);
  });
});

function recorder(opts = {}) {
  const calls = { query: [], resolveBrand: [], global: [], colorDistances: [] };
  const deps = {
    query: async (sql, params) => {
      calls.query.push({ sql, params });
      const rows = typeof opts.rows === "function" ? opts.rows(params) : opts.rows ?? [];
      return { rows, rowCount: rows.length };
    },
    resolveBrand: async (text) => {
      calls.resolveBrand.push(text);
      return opts.brands?.[text.toLowerCase()] ?? null;
    },
    globalCandidates: async (evidence) => {
      calls.global.push(evidence);
      return opts.global ?? [];
    },
    colorDistances: async (ids, hex) => {
      calls.colorDistances.push({ ids, hex });
      return new Map(Object.entries(opts.distances ?? {}).map(([id, d]) => [Number(id), d]));
    },
  };
  return { calls, deps };
}
const ctx = (over = {}) => ({
  userId: USER,
  frameCount: 1,
  hintBrand: null,
  barcodeBrand: null,
  modelCalls: 0,
  visionConfidence: null,
  ...over,
});
const loud = { brandId: 3, name: "Loud Lacquer", score: 0.9 };
const holoTaco = { brandId: 7, name: "Holo Taco", score: 0.95 };

describe("lib/bottle-resolver — resolveBottle", () => {
  it("hint brand pools its shades and matches a confident name", async () => {
    const { calls, deps } = recorder({ rows: [row(11, "Unicorn Skin", { nameScore: 0.95 })] });
    const decision = await resolveBottle(baseEvidence({ shadeName: "Unicorn Skin" }), ctx({ hintBrand: hint(), modelCalls: 2 }), deps);
    assert.equal(decision.status, "matched");
    assert.equal(decision.entityType, "shade");
    assert.equal(decision.entityId, 11);
    assert.equal(decision.confidence, 0.95);
    assert.deepEqual(calls.query[0].params.slice(0, 3), [[3], USER, "Unicorn Skin"]);
    assert.deepEqual(calls.query[0].params.slice(3), [null, null, null]);
    assert.equal(calls.global.length, 0);
    assert.equal(decision.bottle.brand.brandId, "3");
    assert.equal(decision.bottle.modelCalls, 2);
    assert.equal(decision.bottle.tie, false);
    assert.equal(decision.bottle.suggestedShade, undefined, "a match carries no create card");
    assert.equal(decision.metadataPatch.resolver.version, "bottle-v1");
    assert.equal(decision.metadataPatch.resolver.step, "matched_by_name");
    assert.equal(decision.metadataPatch.resolver.method, "name");
    assert.equal(decision.metadataPatch.resolver.modelCalls, 2);
    assert.equal(decision.metadataPatch.resolver.candidateCount, 1);
  });

  it("binds the glass color as OKLAB L/a/b and uses it to confirm a mid-band name", async () => {
    const { calls, deps } = recorder({ rows: [row(11, "Unicorn Skin", { nameScore: 0.8, colorDistance: 0.03 })] });
    const decision = await resolveBottle(
      baseEvidence({ shadeName: "Unicorn Skn", glassHex: "#B4004E" }),
      ctx({ hintBrand: hint() }),
      deps
    );
    assert.equal(decision.status, "matched");
    assert.equal(decision.confidence, 0.92);
    assert.equal(decision.metadataPatch.resolver.method, "name+color");
    const [, , , L, a, b] = calls.query[0].params;
    assert.ok([L, a, b].every((v) => typeof v === "number" && Number.isFinite(v)));
  });

  it("the listed name is lifted with the vision confidence", async () => {
    const { deps } = recorder({ rows: [row(11, "Unicorn Skin", { nameScore: 0.4 }), row(12, "Other", { nameScore: 0.3 })] });
    const decision = await resolveBottle(
      baseEvidence({ shadeName: "unicorn skn", shadeNameListed: "Unicorn Skin" }),
      ctx({ hintBrand: hint(), visionConfidence: 0.85 }),
      deps
    );
    assert.equal(decision.status, "needs_question");
    assert.equal(decision.candidates[0].shadeId, 11);
    assert.equal(decision.candidates[0].confidence, 0.85);
    assert.equal(decision.question.key, "candidate_select");
  });

  it("hint plus a confident read of another brand pools both and reports the conflict", async () => {
    const { calls, deps } = recorder({
      rows: [row(11, "Unicorn Skin", { nameScore: 0.95 }), row(21, "Unicorn Skin", { brandId: "7", brand: "Holo Taco", nameScore: 0.95 })],
      brands: { "holo taco": holoTaco },
    });
    const decision = await resolveBottle(
      baseEvidence({ shadeName: "Unicorn Skin", brandRead: { text: "Holo Taco", confidence: 0.85 } }),
      ctx({ hintBrand: hint() }),
      deps
    );
    assert.deepEqual(calls.query[0].params[0], [3, 7]);
    assert.deepEqual(decision.bottle.brandConflict, {
      hinted: { brandId: "3", name: "Loud Lacquer", source: "hint" },
      read: { brandId: "7", name: "Holo Taco", source: "read", confidence: 0.85 },
    });
    assert.deepEqual(decision.metadataPatch.resolver.brandConflict, decision.bottle.brandConflict);
    assert.equal(decision.bottle.brand.brandId, "3", "the hint stays the session brand");
  });

  it("a read below the conflict bar is not looked up and adds no pool", async () => {
    const { calls, deps } = recorder({ rows: [row(11, "A", { nameScore: 0.95 })], brands: { "holo taco": holoTaco } });
    const decision = await resolveBottle(
      baseEvidence({ shadeName: "A", brandRead: { text: "Holo Taco", confidence: 0.7 } }),
      ctx({ hintBrand: hint() }),
      deps
    );
    assert.deepEqual(calls.query[0].params[0], [3]);
    assert.equal(calls.resolveBrand.length, 0);
    assert.equal(decision.bottle.brandConflict, undefined);
  });

  it("a confident read that resolves to the hint brand is no conflict", async () => {
    const { calls, deps } = recorder({ rows: [row(11, "A", { nameScore: 0.95 })], brands: { "loud lacquer": loud } });
    const decision = await resolveBottle(
      baseEvidence({ shadeName: "A", brandRead: { text: "Loud Lacquer", confidence: 0.9 } }),
      ctx({ hintBrand: hint() }),
      deps
    );
    assert.deepEqual(calls.query[0].params[0], [3]);
    assert.equal(decision.bottle.brandConflict, undefined);
  });

  it("no hint: a read brand that resolves becomes the session brand with source read", async () => {
    const { calls, deps } = recorder({ rows: [row(21, "Unicorn Skin", { brandId: "7", brand: "Holo Taco", nameScore: 0.7 })], brands: { "holo taco": holoTaco } });
    const decision = await resolveBottle(
      baseEvidence({ brand: "Holo Taco", brandSource: "read", shadeName: "Unicorn Skin", brandRead: { text: "Holo Taco", confidence: 0.85 } }),
      ctx(),
      deps
    );
    assert.deepEqual(calls.query[0].params[0], [7]);
    assert.deepEqual(decision.bottle.brand, { brandId: "7", name: "Holo Taco", source: "read", confidence: 0.85 });
    assert.equal(decision.status, "needs_question");
    assert.equal(decision.bottle.suggestedShade.brandSource, "read");
  });

  it("no hint: a read whose brand lookup misses falls to the global candidates, re-ranked by color", async () => {
    const { calls, deps } = recorder({
      brands: {},
      global: [
        { entityType: "shade", entityId: 31, shadeId: 31, display: "A — One", confidence: 0.8 },
        { entityType: "shade", entityId: 32, shadeId: 32, display: "B — One", confidence: 0.8 },
      ],
      distances: { 31: 0.09, 32: 0.02 },
    });
    const decision = await resolveBottle(
      baseEvidence({ brand: "Holo Tco", brandSource: "read", shadeName: "One", glassHex: "#B4004E", brandRead: { text: "Holo Tco", confidence: 0.55 } }),
      ctx(),
      deps
    );
    assert.equal(calls.query.length, 0, "no brand pool query");
    assert.equal(calls.global.length, 1);
    assert.deepEqual(calls.colorDistances, [{ ids: [31, 32], hex: "#B4004E" }]);
    assert.equal(decision.bottle.brand, null);
    assert.equal(decision.bottle.suggestedShade, undefined, "brand unknown: no create card");
    assert.equal(decision.status, "matched", "0.8 name confirmed by a 0.02 color distance");
    assert.equal(decision.entityId, 32);
    assert.equal(decision.metadataPatch.resolver.method, "name+color");
  });

  it("global path without a glass hex asks no color distances", async () => {
    const { calls, deps } = recorder({ global: [{ entityType: "shade", entityId: 31, shadeId: 31, display: "A — One", confidence: 0.8 }] });
    const decision = await resolveBottle(baseEvidence({ shadeName: "One" }), ctx(), deps);
    assert.equal(calls.colorDistances.length, 0);
    assert.equal(decision.status, "needs_question");
    assert.equal(decision.candidates[0].colorDistance, null);
  });

  it("a hint without a catalog brand uses the global path and keeps the raw text for the create card", async () => {
    const { calls, deps } = recorder({ global: [] });
    const rawHint = { brandId: null, name: "loud", source: "hint" };
    const decision = await resolveBottle(baseEvidence({ brand: "loud", brandSource: "hint", shadeName: "Zzz" }), ctx({ hintBrand: rawHint }), deps);
    assert.equal(calls.query.length, 0);
    assert.equal(calls.global.length, 1);
    assert.equal(decision.status, "unmatched");
    assert.equal(decision.bottle.suggestedShade.brandName, "loud");
    assert.equal(decision.bottle.suggestedShade.brandId, null);
    assert.equal(decision.bottle.suggestedShade.brandSource, "hint");
    assert.equal(decision.metadataPatch.resolver.step, "create_card");
  });

  it("a create card is an unmatched decision with the suggested shade in the audit", async () => {
    const { deps } = recorder({ rows: [row(11, "Totally Different", { nameScore: 0.2 })] });
    const decision = await resolveBottle(
      baseEvidence({ shadeName: "Moonlit", glassHex: "#101010", finish: "creme", gtin: "0123456789012" }),
      ctx({ hintBrand: hint() }),
      deps
    );
    assert.equal(decision.status, "unmatched");
    assert.equal(decision.confidence, 0);
    assert.equal(decision.metadataPatch.resolver.step, "create_card");
    assert.equal(decision.metadataPatch.resolver.method, "create_card");
    assert.deepEqual(decision.metadataPatch.resolver.suggestedShade, decision.bottle.suggestedShade);
    assert.deepEqual(decision.bottle.suggestedShade, {
      brandId: "3", brandName: "Loud Lacquer", brandSource: "hint", shadeName: "Moonlit", hex: "#101010", finish: "creme", gtin: "0123456789012",
    });
  });

  it("a name that was typed as a brand_shade answer counts as a hint, not a model read", async () => {
    const { calls, deps } = recorder({ rows: [], brands: { loud: loud } });
    const decision = await resolveBottle(baseEvidence({ brand: "loud", brandSource: "hint", shadeName: "Zzz" }), ctx(), deps);
    assert.equal(calls.resolveBrand[0], "loud");
    assert.deepEqual(calls.query[0].params[0], [3]);
    assert.equal(decision.bottle.suggestedShade.brandSource, "hint");
  });

  it("a confidence-0 read (client-sent text) is user text: source hint, no model-read confidence", async () => {
    const { calls, deps } = recorder({ rows: [], brands: { loud: loud } });
    const decision = await resolveBottle(
      baseEvidence({ brand: "loud", brandSource: "read", shadeName: "Zzz", brandRead: { text: "loud", confidence: 0 } }),
      ctx(),
      deps
    );
    assert.deepEqual(calls.query[0].params[0], [3]);
    assert.equal(decision.bottle.brand.source, "hint");
    assert.equal(decision.bottle.brand.confidence, undefined);
    assert.equal(decision.bottle.suggestedShade.brandSource, "hint");
  });

  it("a low-confidence read (0 < c < 0.6) is not used as the brand", async () => {
    const { calls, deps } = recorder({ brands: { smudge: loud } });
    const decision = await resolveBottle(
      baseEvidence({ brand: "smudge", brandSource: "read", shadeName: "Zzz", brandRead: { text: "smudge", confidence: 0.5 } }),
      ctx(),
      deps
    );
    assert.equal(calls.resolveBrand.length, 0);
    assert.equal(calls.query.length, 0);
    assert.equal(decision.bottle.brand, null);
  });

  it("a barcode brand pools its shades", async () => {
    const { calls, deps } = recorder({ rows: [row(11, "A", { nameScore: 0.95 })] });
    const decision = await resolveBottle(baseEvidence({ shadeName: "A" }), ctx({ barcodeBrand: { brandId: 3, name: "Loud Lacquer" } }), deps);
    assert.deepEqual(calls.query[0].params[0], [3]);
    assert.equal(decision.bottle.brand.source, "barcode");
  });

  it("unknown brand and no shade name keeps today's brand + shade question", async () => {
    const { deps } = recorder({});
    const decision = await resolveBottle(baseEvidence(), ctx({ frameCount: 1 }), deps);
    assert.equal(decision.status, "needs_question");
    assert.equal(decision.question.key, "brand_shade");
    assert.equal(decision.metadataPatch.resolver.step, "needs_brand_and_shade");
  });

  it("unknown brand with a brand and shade text but no match is unmatched", async () => {
    const { deps } = recorder({ global: [] });
    const decision = await resolveBottle(baseEvidence({ brand: "Nope", brandSource: "read", shadeName: "Zzz" }), ctx(), deps);
    assert.equal(decision.status, "unmatched");
    assert.equal(decision.metadataPatch.resolver.step, "unmatched_after_resolver");
  });

  it("color-only candidates carry the tie flag", async () => {
    const { deps } = recorder({ rows: [row(1, "A", { colorDistance: 0.04 }), row(2, "B", { colorDistance: 0.09 })] });
    const decision = await resolveBottle(baseEvidence({ glassHex: "#B4004E" }), ctx({ hintBrand: hint() }), deps);
    assert.equal(decision.status, "needs_question");
    assert.equal(decision.bottle.tie, true);
    assert.equal(decision.metadataPatch.resolver.method, "color");
    assert.equal(decision.candidates[0].colorDistance, 0.04);
    assert.equal(decision.candidates[0].brandId, 3);
    assert.ok(decision.bottle.suggestedShade, "the card stays reachable behind None of these");
  });

  it("the audit lists the top five score components", async () => {
    const rows = [1, 2, 3, 4, 5, 6, 7].map((id) => row(id, `Shade ${id}`, { nameScore: 0.6 - id * 0.01 }));
    const { deps } = recorder({ rows });
    const decision = await resolveBottle(baseEvidence({ shadeName: "Shade" }), ctx({ hintBrand: hint(), modelCalls: 1 }), deps);
    const resolver = decision.metadataPatch.resolver;
    assert.equal(resolver.candidateCount, 7);
    assert.equal(resolver.top5.length, 5);
    assert.deepEqual(Object.keys(resolver.top5[0]).sort(), [
      "brandId", "colorDistance", "colorScore", "display", "fromConflictBrand", "nameScore", "score", "shadeId",
    ]);
    assert.equal(resolver.audit.frameCount, 1);
    assert.equal(resolver.audit.evidence.shadeName, "Shade");
    assert.equal(resolver.audit.thresholds.match, 0.92);
    assert.equal(decision.candidates.length, 5);
  });

  it("every SQL statement binds the user id", async () => {
    const { calls, deps } = recorder({ rows: [] });
    await resolveBottle(baseEvidence({ shadeName: "A" }), ctx({ hintBrand: hint() }), deps);
    assert.ok(calls.query.length > 0);
    for (const call of calls.query) {
      assert.equal(call.params[1], USER);
      assert.match(call.sql, /\$2/);
    }
  });
});

describe("lib/bottle-resolver — SQL", () => {
  const sql = BOTTLE_CANDIDATES_SQL.replace(/\s+/g, " ");
  it("pools by brand with the visibility rules and the pool limit", () => {
    assert.match(sql, /s\.brand_id = ANY\(\$1::bigint\[\]\)/);
    assert.match(sql, /s\.merged_into_shade_id IS NULL/);
    assert.match(sql, /s\.product_category = 'color'/);
    assert.match(sql, /s\.status = 'active' OR \(s\.status = 'user_submitted' AND s\.created_by_user_id = \$2\)/);
    assert.match(sql, /similarity\(s\.shade_name_canonical, \$3::text\)/);
    assert.match(sql, /\$4::float8/);
    assert.match(sql, /\$6::float8/);
    assert.match(sql, /LIMIT 50/);
  });
  it("never exposes another user's private shade", () => {
    assert.ok(!/status = 'user_submitted'(?! AND s\.created_by_user_id = \$2)/.test(sql));
  });
  it("loadColorDistances scopes visibility to the caller and returns a map", async () => {
    const calls = [];
    const db = {
      query: async (text, params) => {
        calls.push({ text, params });
        return { rows: [{ shadeId: "5", distance: 0.07 }, { shadeId: "6", distance: null }], rowCount: 2 };
      },
    };
    const map = await loadColorDistances([5, 6], "#B4004E", USER, db);
    assert.equal(map.get(5), 0.07);
    assert.equal(map.get(6), null);
    assert.deepEqual(calls[0].params[0], [5, 6]);
    assert.equal(calls[0].params[calls[0].params.length - 1], USER);
    assert.match(calls[0].text, /created_by_user_id = \$5/);
    assert.equal((await loadColorDistances([], "#B4004E", USER, db)).size, 0);
    assert.equal(calls.length, 1, "no ids, no query");
  });
});
