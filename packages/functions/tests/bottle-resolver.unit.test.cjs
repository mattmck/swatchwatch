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
    assert.equal(BOTTLE_RESOLVER_VERSION, "bottle-v2");
    assert.deepEqual({ ...BOTTLE_RESOLVER_THRESHOLDS }, {
      match: 0.92,
      question: 0.75,
      createCard: 0.5,
      candidateOnly: 0.6,
      colorHigh: 0.05,
      colorMedium: 0.1,
      brandRead: 0.6,
      brandConflict: 0.8,
      maxCandidates: 5,
      poolLimit: 50,
      brandlessMinWords: 2,
      brandlessMinChars: 8,
      editMinChars: 5,
      editMinSimilarity: 0.8,
      editMinLead: 0.25,
      frontMinChars: 5,
      weakSignal: 0.75,
      brandlessEditMinSimilarity: 0.93,
      brandlessEditMinLead: 0.2,
      globalLimit: 10,
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
  it("puts the listed row first when its lifted score tops the pool, even with null trigrams", () => {
    const scored = scoreBottleCandidates(
      [row(1, "Other", { colorDistance: 0.01 }), row(2, "Unicorn Skin")],
      { shadeNameListed: "unicorn skin", visionConfidence: 0.9, hintBrandId: 3 }
    );
    assert.deepEqual(scored.map((c) => [c.shadeId, c.nameScore]), [[2, 0.9], [1, null]]);
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

describe("lib/bottle-resolver — scoreBottleCandidates (unverified pick, front name)", () => {
  // Bottle eval 2026-11-10: a closed-set pick the printed name did not spell matched a different
  // shade ("Cinnamon Cider 2.0" for "Cinnamon Apple Sangria"); such a pick is now a candidate only.
  it("an unverified pick lifts its row to the candidate-only score, never higher", () => {
    const scored = scoreBottleCandidates(
      [row(1, "Cinnamon Cider 2.0", { nameScore: 0.29 }), row(2, "Swan Song", { nameScore: 0.1 })],
      { shadeNameListed: null, shadeNamePick: "cinnamon cider 2.0", visionConfidence: 1, hintBrandId: 3 }
    );
    assert.equal(scored[0].shadeId, 1);
    assert.equal(scored[0].nameScore, BOTTLE_RESOLVER_THRESHOLDS.candidateOnly);
    assert.ok(scored[0].nameScore < BOTTLE_RESOLVER_THRESHOLDS.question, "color can never confirm it into a match");
    const higher = scoreBottleCandidates([row(1, "A", { nameScore: 0.8 })], { shadeNameListed: null, shadeNamePick: "A", visionConfidence: 1, hintBrandId: null });
    assert.equal(higher[0].nameScore, 0.8, "a higher trigram is kept");
  });
  it("a row the front's printed name spells (frontScore >= 0.92) is a candidate and marked frontNamed", () => {
    const scored = scoreBottleCandidates(
      [row(1, "Camelot", { frontScore: 1 }), row(2, "Guinevere", { frontScore: 0.1 }), row(3, "Morgana")],
      { shadeNameListed: null, visionConfidence: null, hintBrandId: 3 }
    );
    assert.equal(scored[0].shadeId, 1);
    assert.equal(scored[0].nameScore, BOTTLE_RESOLVER_THRESHOLDS.candidateOnly);
    assert.equal(scored[0].frontNamed, true);
    assert.equal(scored.find((c) => c.shadeId === 2).frontNamed, false);
    assert.equal(scored.find((c) => c.shadeId === 2).nameScore, null);
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
  it("an incomplete name (partly hidden) never matches, by name or by name+color", () => {
    const byName = decideBottleResolution([cand(1, 1, 0.01)], { ...known, nameIncomplete: true });
    assert.equal(byName.kind, "candidates");
    assert.equal(byName.candidates[0].shadeId, 1);
    assert.equal(decideBottleResolution([cand(1, 0.8, 0.01)], { ...known, nameIncomplete: true }).kind, "candidates");
  });
  it("a front-named candidate other than the top contradicts a match: ask instead", () => {
    const d = decideBottleResolution([cand(1, 1, null), cand(2, 0.6, null, { frontNamed: true })], known);
    assert.equal(d.kind, "candidates");
    assert.deepEqual(d.candidates.map((c) => c.shadeId), [1, 2]);
    const agrees = decideBottleResolution([cand(1, 1, null, { frontNamed: true })], known);
    assert.equal(agrees.kind, "matched", "the front naming the matched shade is no contradiction");
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
  it("visionConfidenceFromFrames skips a front frame's pick (the front never names the shade)", () => {
    const frames = [
      { frameType: "label", quality: { surface: "front", extracted: { shadeNameListed: "A" }, ai: { sticker: { confidence: 0.95 } } } },
      { frameType: "label", quality: { surface: "bottom", extracted: { shadeNameListed: "A" }, ai: { sticker: { confidence: 0.7 } } } },
    ];
    assert.equal(visionConfidenceFromFrames(frames), 0.7);
    assert.equal(visionConfidenceFromFrames(frames.slice(0, 1)), null);
  });
});

function recorder(opts = {}) {
  const calls = { query: [], names: [], resolveBrand: [], global: [], colorDistances: [] };
  const deps = {
    query: async (sql, params) => {
      if (/LEFT JOIN shade_alias/.test(sql)) {
        // The pool's names and aliases (R1, R2, R4) are recorded apart from the candidate query.
        calls.names.push({ sql, params });
        const names = opts.names ?? [];
        return { rows: names, rowCount: names.length };
      }
      const rows = typeof opts.rows === "function" ? opts.rows(params) : opts.rows ?? [];
      calls.query.push({ sql, params });
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
    assert.deepEqual(calls.query[0].params.slice(3), [null, null, null, null, null, null]);
    assert.equal(calls.global.length, 0);
    assert.equal(decision.bottle.brand.brandId, "3");
    assert.equal(decision.bottle.modelCalls, 2);
    assert.equal(decision.bottle.tie, false);
    assert.equal(decision.bottle.suggestedShade, undefined, "a match carries no create card");
    assert.equal(decision.metadataPatch.resolver.version, "bottle-v2");
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

  it("a listed pick with no printed name binds the listed name as $7 and lifts that row", async () => {
    const { calls, deps } = recorder({ rows: [row(11, "Unicorn Skin"), row(12, "Other", { colorDistance: 0.01 })] });
    const decision = await resolveBottle(
      baseEvidence({ shadeNameListed: "Unicorn Skin" }),
      ctx({ hintBrand: hint(), visionConfidence: 0.95 }),
      deps
    );
    assert.equal(calls.query[0].params[2], null, "no printed name: $3 is null");
    assert.equal(calls.query[0].params[6], "Unicorn Skin");
    assert.equal(decision.status, "matched");
    assert.equal(decision.entityId, 11);
    assert.equal(decision.confidence, 0.95);
  });

  it("hint plus a confident read of another brand pools both and reports the conflict", async () => {
    const { calls, deps } = recorder({
      rows: [row(11, "Unicorn Skin", { nameScore: 0.95 }), row(21, "Unicorn Skin", { brandId: "7", brand: "Holo Taco", nameScore: 0.95 })],
      brands: { "holo taco": holoTaco },
    });
    const decision = await resolveBottle(
      baseEvidence({ shadeName: "Unicorn Skin", brandRead: { text: "Holo Taco", confidence: 0.85, source: "pipeline" } }),
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
      baseEvidence({ shadeName: "A", brandRead: { text: "Holo Taco", confidence: 0.7, source: "pipeline" } }),
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
      baseEvidence({ shadeName: "A", brandRead: { text: "Loud Lacquer", confidence: 0.9, source: "pipeline" } }),
      ctx({ hintBrand: hint() }),
      deps
    );
    assert.deepEqual(calls.query[0].params[0], [3]);
    assert.equal(decision.bottle.brandConflict, undefined);
  });

  it("no hint: a read brand that resolves becomes the session brand with source read", async () => {
    const { calls, deps } = recorder({ rows: [row(21, "Unicorn Skin", { brandId: "7", brand: "Holo Taco", nameScore: 0.7 })], brands: { "holo taco": holoTaco } });
    const decision = await resolveBottle(
      baseEvidence({ brand: "Holo Taco", brandSource: "read", shadeName: "Unicorn Skin", brandRead: { text: "Holo Taco", confidence: 0.85, source: "pipeline" } }),
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
      baseEvidence({ brand: "Holo Tco", brandSource: "read", shadeName: "One", glassHex: "#B4004E", brandRead: { text: "Holo Tco", confidence: 0.55, source: "pipeline" } }),
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

  it("no brand pool: a name-only match needs a distinctive printed name (two words, 8+ letters)", async () => {
    // Bottle eval 2026-11-10, sample 55 (Clionadh "Under The Ladder", brand not in the catalog):
    // the box's "AUSTIN" (the maker's city) matched Zoya "Austin" across all brands.
    const austin = { entityType: "shade", entityId: 41, shadeId: 41, display: "Zoya — Austin", confidence: 1 };
    const { deps } = recorder({ global: [austin] });
    const asked = await resolveBottle(baseEvidence({ shadeName: "AUSTIN" }), ctx(), deps);
    assert.equal(asked.status, "needs_question");
    assert.equal(asked.candidates[0].shadeId, 41, "still offered as a candidate");

    const breathe = { entityType: "shade", entityId: 42, shadeId: 42, display: "Orly — Just Breathe", confidence: 1 };
    const matched = await resolveBottle(baseEvidence({ shadeName: "JUST BREATHE" }), ctx(), recorder({ global: [breathe] }).deps);
    assert.equal(matched.status, "matched");
    assert.equal(matched.entityId, 42);
  });

  it("isDistinctiveBrandlessName: near misses", () => {
    const { isDistinctiveBrandlessName } = require("../dist/lib/bottle-resolver");
    for (const name of ["Just Breathe", "Donut Spunk", "MATTE MADE IN HELL", "Sip Back & Relax"]) assert.equal(isDistinctiveBrandlessName(name), true, name);
    for (const name of ["AUSTIN", "Liberty", "Hera", "La Vie", "E = mc²", "", null, "Moonflower"]) assert.equal(isDistinctiveBrandlessName(name), false, String(name));
  });

  it("a brand pool keeps matching single-word names", async () => {
    const { deps } = recorder({ rows: [row(11, "Hera", { nameScore: 1 })] });
    const decision = await resolveBottle(baseEvidence({ shadeName: "HERA" }), ctx({ hintBrand: hint() }), deps);
    assert.equal(decision.status, "matched");
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
    assert.deepEqual(decision.candidates, [], "no candidate is on screen, so the create card shows");
    assert.equal(decision.metadataPatch.resolver.top5.length, 1, "the score components stay in the audit");
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

  it("a pipeline brand with no confidence is a read: it pools the brand but the card asks to confirm it", async () => {
    const { calls, deps } = recorder({ rows: [], brands: { loud: loud } });
    const decision = await resolveBottle(
      baseEvidence({ brand: "loud", brandSource: "read", shadeName: "Zzz", brandRead: { text: "loud", confidence: 0, source: "pipeline" } }),
      ctx(),
      deps
    );
    assert.deepEqual(calls.query[0].params[0], [3]);
    assert.equal(decision.bottle.brand.source, "read");
    assert.equal(decision.bottle.brand.confidence, undefined, "unscored: no confidence is claimed");
    assert.equal(decision.bottle.suggestedShade.brandSource, "read");
  });

  it("a pipeline brand that does not resolve is no session brand (no card)", async () => {
    const { calls, deps } = recorder({ brands: {}, global: [] });
    const decision = await resolveBottle(
      baseEvidence({ brand: "Lowd", brandSource: "read", shadeName: "Zzz", brandRead: { text: "Lowd", confidence: 0.9, source: "pipeline" } }),
      ctx(),
      deps
    );
    assert.equal(calls.query.length, 0);
    assert.equal(decision.bottle.brand, null);
    assert.equal(decision.bottle.suggestedShade, undefined);
  });

  it("a client-sent (request_quality) brand is typed text: source hint", async () => {
    const { calls, deps } = recorder({ rows: [], brands: { loud: loud } });
    const decision = await resolveBottle(
      baseEvidence({ brand: "loud", brandSource: "read", shadeName: "Zzz", brandRead: { text: "loud", confidence: 0, source: "request_quality" } }),
      ctx(),
      deps
    );
    assert.deepEqual(calls.query[0].params[0], [3]);
    assert.equal(decision.bottle.brand.source, "hint");
    assert.equal(decision.bottle.suggestedShade.brandSource, "hint");
  });

  it("a confident model read that resolves is a read, whatever its confidence", async () => {
    const { deps } = recorder({ rows: [], brands: { loud: loud } });
    const decision = await resolveBottle(
      baseEvidence({ brand: "loud", brandSource: "read", shadeName: "Zzz", brandRead: { text: "loud", confidence: 0.99, source: "pipeline" } }),
      ctx(),
      deps
    );
    assert.equal(decision.bottle.brand.source, "read");
    assert.equal(decision.bottle.suggestedShade.brandSource, "read");
  });

  it("a low-confidence read (0 < c < 0.6) is not used as the brand", async () => {
    const { calls, deps } = recorder({ brands: { smudge: loud } });
    const decision = await resolveBottle(
      baseEvidence({ brand: "smudge", brandSource: "read", shadeName: "Zzz", brandRead: { text: "smudge", confidence: 0.5, source: "pipeline" } }),
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
      "brandId", "colorDistance", "colorScore", "display", "editLead", "editSimilarity", "fromConflictBrand", "frontNamed",
      "nameRule", "nameScore", "score", "shadeId", "signals",
    ]);
    assert.equal(resolver.audit.frameCount, 1);
    assert.equal(resolver.audit.evidence.shadeName, "Shade");
    assert.equal(resolver.audit.thresholds.match, 0.92);
    assert.equal(decision.candidates.length, 5);
  });

  it("v3: an unverified pick binds as $7 (so the pool keeps it) and only ever asks", async () => {
    const { calls, deps } = recorder({
      rows: [row(11, "Cinnamon Cider 2.0", { nameScore: 0.29, colorDistance: 0.01 }), row(12, "Swan Song", { nameScore: 0.05 })],
    });
    const decision = await resolveBottle(
      baseEvidence({ shadeName: "Cinnamon Apple Sangria", shadeNamePick: "Cinnamon Cider 2.0", glassHex: "#6A574A" }),
      ctx({ hintBrand: hint(), visionConfidence: 1 }),
      deps
    );
    assert.equal(calls.query[0].params[6], "Cinnamon Cider 2.0");
    assert.equal(decision.status, "needs_question");
    assert.equal(decision.candidates[0].shadeId, 11);
  });

  it("v3: an incomplete printed name asks instead of matching", async () => {
    const { deps } = recorder({ rows: [row(11, "Orion's Belt", { nameScore: 1 })] });
    const decision = await resolveBottle(
      baseEvidence({ shadeName: "Orion's Belt", shadeNameIncomplete: true }),
      ctx({ hintBrand: hint() }),
      deps
    );
    assert.equal(decision.status, "needs_question");
    assert.equal(decision.candidates[0].shadeId, 11);
  });

  it("v3: a front name binds as $8; with no other name it gives candidates, not a create card", async () => {
    const { calls, deps } = recorder({ rows: [row(11, "Camelot", { frontScore: 1 }), row(12, "Morgana", { frontScore: 0.1 })] });
    const decision = await resolveBottle(baseEvidence({ frontShadeName: "camelot" }), ctx({ hintBrand: hint() }), deps);
    assert.equal(calls.query[0].params[7], "camelot");
    assert.equal(decision.status, "needs_question");
    assert.equal(decision.candidates[0].shadeId, 11);
  });

  it("v3: a front name that spells another shade than the bottom's match turns the match into a question", async () => {
    // Bottle eval: a Morgana bottle photographed with a Guinevere bottle behind it.
    const { deps } = recorder({ rows: [row(11, "Guinevere", { nameScore: 1, frontScore: 0.1 }), row(12, "Morgana", { nameScore: 0.1, frontScore: 1 })] });
    const decision = await resolveBottle(
      baseEvidence({ shadeName: "guinevere", frontShadeName: "morgana" }),
      ctx({ hintBrand: hint() }),
      deps
    );
    assert.equal(decision.status, "needs_question");
    assert.ok(decision.candidates.some((c) => c.shadeId === 12));
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
    assert.match(sql, /s\.product_category IN \('color', 'topper', 'top_coat', 'base_coat', 'treatment'\)/);
    assert.ok(!/accessory/.test(sql), "accessories are never pooled");
    assert.match(sql, /s\.status = 'active' OR \(s\.status = 'user_submitted' AND s\.created_by_user_id = \$2\)/);
    assert.match(sql, /similarity\(s\.shade_name_canonical, \$3::text\)/);
    assert.match(sql, /\$4::float8/);
    assert.match(sql, /\$6::float8/);
    assert.match(sql, /LIMIT 50/);
  });
  it("measures color only for color shades (a topper or coat's stored hex is not the glass color)", () => {
    assert.match(sql, /CASE WHEN s\.product_category <> 'color' THEN NULL WHEN NULLIF\(s\.vendor_hex, ''\) IS NULL/);
  });
  it("scores the front name as frontScore from $8", () => {
    assert.match(sql, /similarity\(s\.shade_name_canonical, \$8::text\) AS "frontScore"/);
  });
  it("sorts the listed pick first so the pool limit cannot cut it", () => {
    assert.match(sql, /\$7::text/);
    assert.match(sql, /ORDER BY COALESCE\(s\.shade_id = ANY\(\$9::bigint\[\]\), false\) DESC, COALESCE\(lower\(s\.shade_name_canonical\) = lower\(\$7::text\), false\) DESC, /);
  });
  it("sorts a row the front's name spells right after the pick, so a 50+ shade pool cannot cut it", () => {
    // Review: with only a front name, the front-named shade of a brand with more than 50 pooled
    // shades could fall outside the pool, so the front/bottom contradiction veto never fired.
    assert.match(
      sql,
      /COALESCE\(lower\(s\.shade_name_canonical\) = lower\(\$7::text\), false\) DESC, COALESCE\(similarity\(s\.shade_name_canonical, \$8::text\) >= 0\.92, false\) DESC, "nameScore" DESC NULLS LAST/
    );
  });
  it("never exposes another user's private shade", () => {
    assert.ok(!/status = 'user_submitted'(?! AND s\.created_by_user_id = \$2)/.test(sql));
  });
  it("never measures color against a hex that is only guessed from the shade name", async () => {
    // A name_hex is a guess from the color name ("High Dive" -> slate blue). Compared with the
    // glass photo it vetoed perfect name reads (bottle eval 2026-11-10: 5 of 18 samples).
    const guard = /CASE WHEN NULLIF\(s\.vendor_hex, ''\) IS NULL AND NULLIF\(s\.detected_hex, ''\) IS NULL THEN NULL ELSE sqrt\(/;
    assert.match(sql, /NULLIF\(s\.vendor_hex, ''\) IS NULL AND NULLIF\(s\.detected_hex, ''\) IS NULL THEN NULL ELSE sqrt\(/);
    const calls = [];
    const db = { query: async (text) => (calls.push(text), { rows: [], rowCount: 0 }) };
    await loadColorDistances([5], "#B4004E", USER, db);
    assert.match(calls[0].replace(/\s+/g, " "), guard);
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

/**
 * Name rules (bottle-v2). Only an exact printed name matches on its own; every weaker signal
 * (edit by lead, exact front name, vendor code) lifts its shade into the question band only, so a
 * measured color within `colorHigh` or a second, different signal is needed for a match.
 */
describe("lib/bottle-resolver — name rules (bottle-v2)", () => {
  const {
    BOTTLE_POOL_NAMES_SQL,
    BOTTLE_GLOBAL_CANDIDATES_SQL,
    planPoolNameLifts,
    planBrandlessLift,
    vendorCodeTokens,
    loadBottleGlobalCandidates,
    frontNonNameWords,
  } = require("../dist/lib/bottle-resolver");

  /**
   * A brand pool: `names` answers the names query, `rows` the candidate query. Candidate rows
   * carry the trigram score `pg_trgm` would give (set per test) and are cut to `limit` unless
   * the resolver forces a shade id ($9), as the SQL sorts those first.
   */
  function pool(shades, { limit = 50, finishWords } = {}) {
    const names = shades.map((s) => ({ shadeId: String(s.id), shadeName: s.name, collection: s.collection ?? null, aliases: s.aliases ?? [] }));
    const rows = (params) => {
      const forced = new Set((params[8] ?? []).map(Number));
      const all = shades.map((s) =>
        row(s.id, s.name, { nameScore: s.trigram ?? null, colorDistance: s.colorDistance ?? null, frontScore: s.frontScore ?? null })
      );
      return [...all.filter((r) => forced.has(Number(r.shadeId))), ...all.filter((r) => !forced.has(Number(r.shadeId))).slice(0, limit)];
    };
    const rec = recorder({ names, rows });
    if (finishWords) rec.deps.finishWords = async () => finishWords;
    return rec;
  }
  const resolveIn = (shades, evidence, opts) => {
    const rec = pool(shades, opts);
    return resolveBottle(baseEvidence(evidence), ctx({ hintBrand: hint() }), rec.deps).then((decision) => ({ decision, calls: rec.calls }));
  };
  const resolver = (decision) => decision.metadataPatch.resolver;
  const firstId = (decision) => decision.candidates[0]?.shadeId;

  // Exact printed name: matches on its own.
  it("exact: a printed name equal (normalised) to one shade's name matches on its own", async () => {
    const { decision } = await resolveIn([{ id: 1, name: "Sleet Deal", trigram: 0.88 }, { id: 2, name: "Steal Deal", trigram: 0.5 }], {
      shadeName: "Sleet Deal(R)",
    });
    assert.equal(decision.status, "matched");
    assert.equal(decision.entityId, 1);
    assert.equal(resolver(decision).nameRule, "exact");
    assert.equal(resolver(decision).matchBasis, "exact");
  });

  it("exact: spacing and case do not matter (MOON FLOWER = Moonflower)", async () => {
    const { decision } = await resolveIn([{ id: 1, name: "Moonflower", trigram: 0.5 }, { id: 2, name: "Moon Dust", trigram: 0.3 }], {
      shadeName: "MOON FLOWER",
    });
    assert.equal(decision.status, "matched");
    assert.equal(decision.entityId, 1);
  });

  it("exact: an exact name wins although a longer name contains it", async () => {
    const { decision } = await resolveIn(
      [{ id: 1, name: "Moonlight", trigram: 0.7 }, { id: 2, name: "Moonlight Sonata", trigram: 0.5 }],
      { shadeName: "MOONLIGHT" }
    );
    assert.equal(decision.status, "matched");
    assert.equal(decision.entityId, 1);
  });

  it("exact: a retailer listing title (non-code alias) names its shade (rule alias)", async () => {
    const { decision } = await resolveIn(
      [{ id: 1, name: "Sniff Test", aliases: ["Sniff Test PPU Exclusive"], trigram: 0.3 }, { id: 2, name: "Smell Check", trigram: 0.1 }],
      { shadeName: "Sniff Test PPU Exclusive" }
    );
    assert.equal(decision.status, "matched");
    assert.equal(decision.entityId, 1);
    assert.equal(resolver(decision).nameRule, "alias");
  });

  it("exact: the winner outside the trigram top 50 is forced into the candidate query and matched", async () => {
    const shades = [
      ...Array.from({ length: 60 }, (_, i) => ({ id: 100 + i, name: `Glitter Bomb ${i}`, trigram: 0.3 })),
      { id: 7, name: "The Purp", trigram: 0.2 },
    ];
    const { decision, calls } = await resolveIn(shades, { shadeName: "THE PURP" });
    assert.deepEqual(calls.query[0].params[8], [7]);
    assert.equal(decision.status, "matched");
    assert.equal(decision.entityId, 7);
  });

  it("exact: an incomplete name never matches (the veto stays), even when it spells a shade", async () => {
    const { decision } = await resolveIn([{ id: 1, name: "Party Fowl", trigram: 1 }], { shadeName: "Party Fowl", shadeNameIncomplete: true });
    assert.equal(decision.status, "needs_question");
    assert.equal(resolver(decision).audit.nameRules.printed, null, "no rule runs on a cut-off name");
  });

  it("exact: two shades with the same normalised name are no decision", () => {
    const entries = [{ shadeId: 1, name: "Snow Much Fun" }, { shadeId: 2, name: "Snow-Much Fun!" }, { shadeId: 3, name: "Blizzard" }];
    const plan = planPoolNameLifts(baseEvidence({ shadeName: "Snow Much Fun" }), entries);
    assert.equal(plan.lifts.size, 0);
  });

  it("the printed name is used, never the unverified pick", () => {
    const entries = [{ shadeId: 1, name: "Sleet Deal" }, { shadeId: 2, name: "Street Deal" }];
    const plan = planPoolNameLifts(baseEvidence({ shadeNamePick: "Sleet Deal" }), entries);
    assert.equal(plan.lifts.size, 0);
  });

  // Weak signal: edit by lead.
  it("lead: a not-in-catalog near-twin (Polly vs Lolly) without color is a question with the twin first", async () => {
    const { decision } = await resolveIn([{ id: 1, name: "Lolly", trigram: 0.33 }, { id: 2, name: "Jubilee", trigram: 0.05 }], {
      shadeName: "Polly",
    });
    assert.equal(decision.status, "needs_question");
    assert.equal(firstId(decision), 1);
    assert.deepEqual(resolver(decision).top5[0].signals, ["edit_lead"]);
    assert.equal(resolver(decision).top5[0].nameScore, 0.75);
  });

  it("lead: a measured glass color within colorHigh confirms it (name+color, signal_and_color)", async () => {
    const { decision } = await resolveIn([{ id: 1, name: "Party Fowl", trigram: 0.47, colorDistance: 0.03 }], {
      shadeName: "Party Foul",
      glassHex: "#B4004E",
    });
    assert.equal(decision.status, "matched");
    assert.equal(decision.entityId, 1);
    assert.equal(resolver(decision).method, "name+color");
    assert.equal(resolver(decision).matchBasis, "signal_and_color");
    assert.deepEqual(resolver(decision).signals, ["edit_lead"]);
  });

  it("lead: a measured color beyond colorHigh leaves it a question", async () => {
    for (const colorDistance of [0.07, 0.2]) {
      const { decision } = await resolveIn([{ id: 1, name: "Party Fowl", trigram: 0.47, colorDistance }], {
        shadeName: "Party Foul",
        glassHex: "#B4004E",
      });
      assert.equal(decision.status, "needs_question", `distance ${colorDistance}`);
      assert.equal(firstId(decision), 1);
    }
  });

  it("lead: a shade with only a guessed (name_hex) color has no distance, so it is asked, never confirmed", async () => {
    // BOTTLE_CANDIDATES_SQL returns colorDistance NULL for a name_hex-only shade (tested in the SQL block).
    const { decision } = await resolveIn([{ id: 1, name: "Party Fowl", trigram: 0.47, colorDistance: null }], {
      shadeName: "Party Foul",
      glassHex: "#B4004E",
    });
    assert.equal(decision.status, "needs_question");
  });

  it("lead/exact: a read shorter than 5 characters gives no rule, even when it spells a shade (R U B Y)", async () => {
    // "R U B Y" normalises to "ruby" (4 characters): without the floor it would be an exact name.
    const { decision } = await resolveIn([{ id: 1, name: "Ruby", trigram: 0.1 }, { id: 2, name: "Opal", trigram: 0.1 }], { shadeName: "R U B Y" });
    assert.notEqual(decision.status, "matched");
    assert.equal(decision.candidates.find((c) => c.shadeId === 1)?.confidence ?? 0.1, 0.1, "Ruby is not lifted");
    assert.equal(resolver(decision).audit.nameRules.printed, null);
  });

  it("lead: two close names (lead under 0.25) give no signal and stay a question", async () => {
    const { decision } = await resolveIn(
      [{ id: 1, name: "Purple Rain", trigram: 0.6 }, { id: 2, name: "Purple Reign", trigram: 0.6 }],
      { shadeName: "Purple Rein" }
    );
    assert.equal(decision.status, "needs_question");
    assert.deepEqual(decision.candidates.map((c) => c.shadeId).sort(), [1, 2]);
    assert.deepEqual(resolver(decision).audit.nameRules.signals, []);
  });

  it("lead: a lift never outvotes another shade's own trigram name in the question band", async () => {
    const { decision } = await resolveIn(
      [{ id: 1, name: "Party Fowl", trigram: 0.2, colorDistance: 0.01 }, { id: 2, name: "Foul Party", trigram: 0.8 }],
      { shadeName: "Party Foul", glassHex: "#B4004E" }
    );
    assert.notEqual(decision.status === "matched" && decision.entityId, 1);
    // Behaviour: Party Fowl stays at its own trigram score (0.2), not the lifted 0.75.
    assert.equal(decision.candidates.find((c) => c.shadeId === 1).confidence, 0.2);
    assert.deepEqual(resolver(decision).audit.nameRules.dropped, [1]);
  });

  it("front: an exact unique front name without color is a question with that shade first", async () => {
    const { decision } = await resolveIn([{ id: 1, name: "Hell Hath No Fury", frontScore: 1 }, { id: 2, name: "Fury Road" }], {
      frontShadeName: "HELL HATH NO FURY",
    });
    assert.equal(decision.status, "needs_question");
    assert.equal(firstId(decision), 1);
    assert.deepEqual(resolver(decision).top5[0].signals, ["front_exact"]);
  });

  it("front: with a measured color within colorHigh it matches by name+color", async () => {
    const { decision } = await resolveIn([{ id: 1, name: "Hell Hath No Fury", frontScore: 1, colorDistance: 0.02 }], {
      frontShadeName: "Hell Hath No Fury",
      glassHex: "#B4004E",
    });
    assert.equal(decision.status, "matched");
    assert.equal(resolver(decision).matchBasis, "signal_and_color");
  });

  it("front: a front that reads a collection name gives no lift", async () => {
    // Mooncat: "Danse Macabre" is a shade and the collection of six others. With a lift the
    // 0.01 color distance would confirm it; blocked, it stays a candidate.
    const shades = [
      { id: 1, name: "Danse Macabre", collection: "Danse Macabre", frontScore: 1, colorDistance: 0.01 },
      { id: 2, name: "Bone Dance", collection: "Danse Macabre" },
    ];
    const { decision } = await resolveIn(shades, { frontShadeName: "DANSE MACABRE", glassHex: "#B4004E" });
    assert.notEqual(decision.status, "matched");
    assert.equal(resolver(decision).audit.nameRules.front.blocked, "collection_or_finish");
    assert.deepEqual(resolver(decision).audit.nameRules.signals, []);
  });

  it("front: a front that reads a finish word gives no lift (KBShimmer has a shade named Magnetic)", async () => {
    const { decision } = await resolveIn(
      [{ id: 1, name: "Magnetic", frontScore: 1, colorDistance: 0.01 }, { id: 2, name: "Flakie" }],
      { frontShadeName: "Magnetic", glassHex: "#B4004E" },
      { finishWords: ["magnetic", "holographic", "flakies"] }
    );
    assert.notEqual(decision.status, "matched");
    assert.equal(resolver(decision).audit.nameRules.front.blocked, "collection_or_finish");
  });

  it("frontNonNameWords normalises collections and finish words", () => {
    const words = frontNonNameWords([{ shadeId: "1", shadeName: "A", collection: "Danse Macabre" }, { shadeId: "2", shadeName: "B" }], ["Glow-In-The-Dark"]);
    assert.deepEqual([...words].sort(), ["dansemacabre", "glowinthedark"]);
  });

  it("front: two shades sharing the front name (after normalisation) give no signal", async () => {
    const { decision } = await resolveIn(
      [{ id: 1, name: "Witchy Woman", frontScore: 1 }, { id: 2, name: "Witchy-Woman", frontScore: 0.9 }],
      { frontShadeName: "Witchy Woman" }
    );
    assert.notEqual(decision.status, "matched");
    assert.deepEqual(resolver(decision).audit.nameRules.signals, []);
  });

  it("front: shorter than 5 characters gives no signal (a confirming color does not match it)", async () => {
    const { decision } = await resolveIn([{ id: 1, name: "Jinx", frontScore: 1, colorDistance: 0.01 }], {
      frontShadeName: "Jinx",
      glassHex: "#B4004E",
    });
    assert.notEqual(decision.status, "matched");
  });

  it("front: a bottom name that names another shade contradicts the front: question with both", async () => {
    const { decision } = await resolveIn(
      [{ id: 1, name: "Witchy Woman", frontScore: 1, trigram: 0.1 }, { id: 2, name: "Moon Goddess", trigram: 0.95 }],
      { frontShadeName: "Witchy Woman", shadeName: "Moon Goddess" }
    );
    assert.equal(decision.status, "needs_question");
    assert.deepEqual(decision.candidates.map((c) => c.shadeId).sort(), [1, 2]);
    assert.equal(resolver(decision).audit.nameRules.front.contradictedBy, 2);
  });

  // Two different weak signals.
  it("two weak signals on one shade without color stay a question (bottom Polly + front Lolly read off another bottle)", async () => {
    const { decision } = await resolveIn(
      [{ id: 1, name: "Lolly", trigram: 0.33, frontScore: 1 }, { id: 2, name: "Jubilee", trigram: 0.05 }],
      { shadeName: "Polly", frontShadeName: "Lolly" }
    );
    assert.equal(decision.status, "needs_question");
    assert.equal(decision.candidates[0].shadeId, 1);
    assert.deepEqual(resolver(decision).top5[0].signals, ["edit_lead", "front_exact"], "both signals are recorded");
    assert.equal(resolver(decision).top5[0].nameScore, 0.75, "lifted to weakSignal once");
  });

  it("two weak signals on one shade without color stay a question (bottom Polly + Lolly's code)", async () => {
    const { decision } = await resolveIn(
      [{ id: 1, name: "Lolly", aliases: ["ZP412"], trigram: 0.33 }, { id: 2, name: "Margot", aliases: ["ZP777"] }],
      { shadeName: "Polly", frontShadeName: "ZP412" }
    );
    assert.equal(decision.status, "needs_question");
    assert.equal(decision.candidates[0].shadeId, 1);
    assert.deepEqual(resolver(decision).top5[0].signals, ["code", "edit_lead"]);
  });

  it("two weak signals on one shade match only with a measured color within colorHigh", async () => {
    const shades = (colorDistance) => [
      { id: 1, name: "Lolly", aliases: ["ZP412"], trigram: 0.33, colorDistance },
      { id: 2, name: "Margot", aliases: ["ZP777"] },
    ];
    const close = await resolveIn(shades(0.02), { shadeName: "Polly", frontShadeName: "ZP412", glassHex: "#B4004E" });
    assert.equal(close.decision.status, "matched");
    assert.equal(resolver(close.decision).matchBasis, "signal_and_color");
    const far = await resolveIn(shades(0.08), { shadeName: "Polly", frontShadeName: "ZP412", glassHex: "#B4004E" });
    assert.equal(far.decision.status, "needs_question");
  });

  it("competing weak signals ask: the color must not pick between them (Polly -> Lolly by lead, Margot's code, glass at Margot)", async () => {
    const { decision } = await resolveIn(
      [
        { id: 1, name: "Lolly", aliases: ["ZP412"], trigram: 0.33, colorDistance: 0.3 },
        { id: 2, name: "Margot", aliases: ["ZP777"], colorDistance: 0.01 },
      ],
      { shadeName: "Polly", frontShadeName: "ZP777", glassHex: "#B4004E" }
    );
    assert.equal(decision.status, "needs_question");
    assert.deepEqual(decision.candidates.map((c) => c.shadeId).sort(), [1, 2]);
  });

  it("competing weak signals ask even when the colored one is a lead and the other a front name", async () => {
    const { decision } = await resolveIn(
      [
        { id: 1, name: "Party Fowl", trigram: 0.47, colorDistance: 0.01 },
        { id: 2, name: "Witchy Woman", frontScore: 1 },
      ],
      { shadeName: "Party Foul", frontShadeName: "Witchy Woman", glassHex: "#B4004E" }
    );
    assert.equal(decision.status, "needs_question");
    assert.deepEqual(decision.candidates.map((c) => c.shadeId).sort(), [1, 2]);
  });

  it("code: a printed vendor code alone is a question with that shade first", async () => {
    const { decision } = await resolveIn(
      [{ id: 1, name: "Big Apple Red", aliases: ["NLN25"] }, { id: 2, name: "Malaga Wine", aliases: ["NLL87"] }],
      { shadeName: "NLN25" }
    );
    assert.equal(decision.status, "needs_question");
    assert.equal(firstId(decision), 1);
    assert.deepEqual(resolver(decision).top5[0].signals, ["code"]);
  });

  it("code: a code two shades share is no signal", async () => {
    const { decision } = await resolveIn(
      [{ id: 1, name: "Big Apple Red", aliases: ["2000344"] }, { id: 2, name: "Big Apple Red Mini", aliases: ["2000344"] }],
      { frontShadeName: "2000344" }
    );
    assert.notEqual(decision.status, "matched");
    assert.deepEqual(resolver(decision).audit.nameRules.signals, []);
  });

  it("code: a code and an exact name of another shade give a question listing both", async () => {
    const { decision } = await resolveIn(
      [
        { id: 1, name: "Big Apple Red", aliases: ["NLN25"], trigram: 0.1 },
        { id: 2, name: "Malaga Wine", trigram: 1 },
        { id: 3, name: "Other", trigram: 0.1 },
      ],
      { shadeName: "Malaga Wine", frontShadeName: "NLN25" }
    );
    assert.equal(decision.status, "needs_question");
    assert.deepEqual(decision.candidates.map((c) => c.shadeId).slice(0, 2).sort(), [1, 2]);
  });

  it("vendorCodeTokens keeps code-shaped tokens of each text", () => {
    assert.deepEqual(vendorCodeTokens(["OPI NLF008 Matte", null, "No. 2000344"]).sort(), ["2000344", "NLF008"]);
    assert.deepEqual(vendorCodeTokens(["Snow Much Fun"]), []);
  });

  // Generic label text.
  it("generic: a read phrase that is generic label text decides nothing (NAIL POLISH vs Nail Police)", () => {
    const entries = [{ shadeId: 1, name: "Nail Police" }, { shadeId: 2, name: "Nail Polish" }, { shadeId: 3, name: "Other" }];
    const plan = planPoolNameLifts(baseEvidence({ shadeName: "NAIL POLISH", frontShadeName: "Nail Polish" }), entries);
    assert.equal(plan.lifts.size, 0);
    assert.equal(plan.audit.printed, null);
  });

  it("generic: a trigram 1.0 on a generic-named shade still matches as in v1", async () => {
    const { decision } = await resolveIn([{ id: 1, name: "Nail Polish", trigram: 1 }, { id: 2, name: "Ocean Mist", trigram: 0.1 }], {
      shadeName: "Nail Polish",
    });
    assert.equal(decision.status, "matched");
    assert.equal(decision.entityId, 1);
    assert.equal(resolver(decision).nameRule, "trigram");
  });

  it("generic: a verified listed pick of a generic-named shade still lifts as in v1", () => {
    const scored = scoreBottleCandidates([row(1, "Top Coat", { nameScore: 0.4 })], {
      shadeNameListed: "Top Coat", visionConfidence: 0.95, hintBrandId: 3,
    });
    assert.equal(scored[0].nameScore, 0.95);
  });

  // Visibility.
  it("the pool names, aliases and collections query has the pool's visibility rules", () => {
    const sql = BOTTLE_POOL_NAMES_SQL.replace(/\s+/g, " ");
    assert.match(sql, /s\.brand_id = ANY\(\$1::bigint\[\]\)/);
    assert.match(sql, /s\.merged_into_shade_id IS NULL/);
    assert.match(sql, /s\.product_category IN \('color', 'topper', 'top_coat', 'base_coat', 'treatment'\)/);
    assert.match(sql, /\(s\.status = 'active' OR \(s\.status = 'user_submitted' AND s\.created_by_user_id = \$2\)\)/);
    assert.match(sql, /s\.collection AS collection/);
    assert.match(sql, /LEFT JOIN shade_alias a ON a\.shade_id = s\.shade_id/);
    assert.ok(!/LIMIT/.test(sql), "the edit rule must see every competitor");
  });

  it("the names query binds the brands and the caller", async () => {
    const { calls } = await resolveIn([{ id: 1, name: "A" }], { shadeName: "Something" });
    assert.deepEqual(calls.names[0].params, [[3], USER]);
  });

  it("visibility: another user's private, a merged or an excluded shade cannot reach a name rule (the SQL predicate excludes them)", () => {
    // The rules only see rows BOTTLE_POOL_NAMES_SQL returns; this pins the predicate that keeps
    // those shades out (a mock row cannot show it). Checked on the dev database too.
    for (const sql of [BOTTLE_POOL_NAMES_SQL, BOTTLE_CANDIDATES_SQL, BOTTLE_GLOBAL_CANDIDATES_SQL].map((q) => q.replace(/\s+/g, " "))) {
      assert.match(sql, /s\.merged_into_shade_id IS NULL/);
      assert.match(sql, /AND \(s\.status = 'active' OR \(s\.status = 'user_submitted' AND s\.created_by_user_id = \$2\)\)/);
      assert.ok(!/status = 'excluded'|status IN/.test(sql));
    }
  });

  // R3 — no brand pool.
  const g = (shadeId, brand, shadeName, confidence) => ({
    entityType: "shade", entityId: shadeId, shadeId, display: `${brand} — ${shadeName}`, confidence, shadeName,
  });

  it("R3: a distinctive unique name one letter off is a weak signal across brands: asked without color", async () => {
    const { deps } = recorder({ global: [g(1, "Mooncat", "Matte Made in Hell", 0.86), g(2, "Zoya", "Made in Heaven", 0.3)] });
    const decision = await resolveBottle(baseEvidence({ shadeName: "Matte Made in Hel" }), ctx(), deps);
    assert.equal(decision.status, "needs_question");
    assert.equal(decision.candidates[0].shadeId, 1);
    assert.deepEqual(resolver(decision).top5[0].signals, ["brandless_edit"]);
  });

  it("R3: ...and matched when the measured color confirms it within colorHigh", async () => {
    const global = [g(1, "Mooncat", "Matte Made in Hell", 0.86), g(2, "Zoya", "Made in Heaven", 0.3)];
    const evidence = baseEvidence({ shadeName: "Matte Made in Hel", glassHex: "#B4004E" });
    const close = await resolveBottle(evidence, ctx(), recorder({ global, distances: { 1: 0.03 } }).deps);
    assert.equal(close.status, "matched");
    assert.equal(resolver(close).matchBasis, "signal_and_color");
    const far = await resolveBottle(evidence, ctx(), recorder({ global, distances: { 1: 0.07 } }).deps);
    assert.equal(far.status, "needs_question");
  });

  it("R3: a near-twin of another brand's shade with no brand (High Mintenance vs High Maintenance) is never matched by name", async () => {
    const { deps } = recorder({ global: [g(1, "Cirque Colors", "High Maintenance", 0.6), g(2, "Zoya", "High Tide", 0.3)] });
    const decision = await resolveBottle(baseEvidence({ shadeName: "High Mintenance" }), ctx(), deps);
    assert.equal(decision.status, "needs_question");
    const spaced = await resolveBottle(baseEvidence({ shadeName: "Blue Bird Song" }), ctx(), recorder({ global: [g(3, "ILNP", "Bluebird Song", 0.5)] }).deps);
    assert.equal(spaced.status, "needs_question", "a spacing-only variant equal after normalisation is a weak signal too");
  });

  it("R3: a name two brands share stays a question", async () => {
    const { deps } = recorder({ global: [g(1, "KBShimmer", "Snow Much Fun", 1), g(2, "Starrily", "Snow Much Fun", 1)] });
    const decision = await resolveBottle(baseEvidence({ shadeName: "Snow Much Fun" }), ctx(), deps);
    assert.equal(decision.status, "needs_question");
    assert.equal(resolver(decision).audit.nameRules.brandlessShared, true);
  });

  it("R3: an exact single word never matches without a brand", async () => {
    const { deps } = recorder({ global: [g(1, "ILNP", "Dreamscape", 1)] });
    const decision = await resolveBottle(baseEvidence({ shadeName: "DREAMSCAPE" }), ctx(), deps);
    assert.equal(decision.status, "needs_question");
    assert.equal(decision.candidates[0].shadeId, 1);
  });

  it("R3: an incomplete name or a lead under 0.2 is no decision", () => {
    const candidates = [{ shadeId: 1, shadeName: "Lilac Dreams" }, { shadeId: 2, shadeName: "Lilac Dream" }];
    assert.equal(planBrandlessLift(baseEvidence({ shadeName: "Lilac Dreams" }), candidates), null, "lead 0.08");
    assert.equal(planBrandlessLift(baseEvidence({ shadeName: "The Gift of Divinity", shadeNameIncomplete: true }), [{ shadeId: 1, shadeName: "The Gift of Divinity" }]), null);
    assert.ok(planBrandlessLift(baseEvidence({ shadeName: "The Gift of Divinity" }), [{ shadeId: 1, shadeName: "The Gift of Divinity" }]));
  });

  it("R3: any unresolved brand read (any confidence, unscored too) turns a cross-brand name match into a question", async () => {
    // Bottle eval 2026-11-11, sample 43: "The Foxglove King" (a collection name, 0.9) read as the brand.
    const global = [g(1, "Bee's Knees Lacquer", "The Gift of Divinity", 1)];
    for (const confidence of [0.9, 0.36, 0]) {
      const evidence = baseEvidence({
        brand: "The Foxglove King", brandSource: "read", shadeName: "The Gift of Divinity",
        brandRead: { text: "The Foxglove King", confidence, source: "pipeline" },
      });
      const decision = await resolveBottle(evidence, ctx(), recorder({ global }).deps);
      assert.equal(decision.status, "needs_question", `confidence ${confidence}`);
      assert.equal(decision.candidates[0].shadeId, 1);
    }
  });

  it("R3: an unresolved brand read still matches when the measured color confirms within colorHigh", async () => {
    const global = [g(1, "Bee's Knees Lacquer", "The Gift of Divinity", 1)];
    const evidence = baseEvidence({
      brand: "(logo)", brandSource: "read", shadeName: "The Gift of Divinity", glassHex: "#B4004E",
      brandRead: { text: "(logo)", confidence: 0.36, source: "pipeline" },
    });
    const close = await resolveBottle(evidence, ctx(), recorder({ global, distances: { 1: 0.03 } }).deps);
    assert.equal(close.status, "matched");
    const far = await resolveBottle(evidence, ctx(), recorder({ global, distances: { 1: 0.07 } }).deps);
    assert.equal(far.status, "needs_question");
  });

  it("R3: with no brand text at all a unique distinctive exact name matches (v1 plus the filter fix)", async () => {
    const global = [g(1, "Bee's Knees Lacquer", "The Gift of Divinity", 1)];
    const decision = await resolveBottle(baseEvidence({ shadeName: "The Gift of Divinity" }), ctx(), recorder({ global }).deps);
    assert.equal(decision.status, "matched");
  });

  it("R3: a brand read that did not resolve is not a filter; a typed brand is", async () => {
    const rec = recorder({ global: [] });
    await resolveBottle(
      baseEvidence({ brand: "(logo)", brandSource: "read", shadeName: "Matte Made in Hell", brandRead: { text: "(logo)", confidence: 0.36, source: "pipeline" } }),
      ctx(),
      rec.deps
    );
    assert.equal(rec.calls.global[0].brand, undefined);
    const typed = recorder({ global: [] });
    await resolveBottle(baseEvidence({ brand: "loud", brandSource: "hint", shadeName: "Zzz" }), ctx({ hintBrand: { brandId: null, name: "loud", source: "hint" } }), typed.deps);
    assert.equal(typed.calls.global[0].brand, "loud");
  });

  it("the global candidates query has the pool's visibility rules and binds the caller", async () => {
    const sql = BOTTLE_GLOBAL_CANDIDATES_SQL.replace(/\s+/g, " ");
    assert.match(sql, /s\.product_category IN \('color', 'topper', 'top_coat', 'base_coat', 'treatment'\)/);
    assert.match(sql, /\$3::text IS NULL OR b\.name_canonical ILIKE \$3::text/);
    assert.match(sql, /LIMIT 10/);
    const calls = [];
    const db = { query: async (text, params) => (calls.push({ text, params }), { rows: [{ shadeId: "4", brand: "Zoya", shadeName: "Austin", score: 0.5 }] }) };
    const got = await loadBottleGlobalCandidates(baseEvidence({ shadeName: "Austin" }), USER, db);
    assert.deepEqual(calls[0].params, ["Austin", USER, null]);
    assert.deepEqual(got, [{ entityType: "shade", entityId: 4, shadeId: 4, display: "Zoya — Austin", confidence: 0.5, shadeName: "Austin" }]);
    assert.deepEqual(await loadBottleGlobalCandidates(baseEvidence(), USER, db), []);
  });
});
