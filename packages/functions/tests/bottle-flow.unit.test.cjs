/**
 * Server-driven bottle prompts (Bottle Flow slice A, Task 9): the pure planner that decides
 * which photo to ask for next, and the state helpers that keep its counters in
 * `metadata.bottle`. No database, no handlers.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  SURFACE_PROMPTS,
  FRONT_BOX_HINT,
  TIE_BREAK_HINTS,
  RETRY_HINTS,
  BOTTLE_MAX_PROMPTS_PER_KEY,
  readBottleFlowState,
  readLastNextFrame,
  promptKey,
  planNextFrame,
  recordPrompt,
  recordSkip,
  recordRejected,
  bottleFlowMetadataPatch,
  decisionForPlan,
} = require("../dist/lib/bottle-flow");

const EMPTY = { prompts: {}, skipped: [], lastRejected: null };

/** Planner input for a session with nothing known and no frames. */
function input(over = {}) {
  return {
    state: EMPTY,
    frameCount: 0,
    maxFrames: 6,
    surfaces: {},
    brandKnown: false,
    nameRead: false,
    glassHex: false,
    decision: "none",
    ...over,
  };
}

function withState(over) {
  return { ...EMPTY, ...over };
}

describe("lib/bottle-flow — constants", () => {
  it("pins the four prompts, the hints and the prompt cap", () => {
    assert.deepEqual(SURFACE_PROMPTS, {
      front: "Show the front of the bottle",
      bottom: "Now the bottom",
      glass: "Turn it so we see the color",
      box: "Have the box? Show the barcode",
    });
    assert.equal(FRONT_BOX_HINT, "No front label? Show the box barcode instead");
    assert.deepEqual([...TIE_BREAK_HINTS], ["Tilt it toward the light", "Hold it against something white"]);
    assert.deepEqual(RETRY_HINTS, {
      "too-dark": "Looks dark — move into better light",
      "too-bright": "Too bright — move out of the glare",
      blurry: "Looks blurry — hold steady and tap to focus",
    });
    assert.equal(BOTTLE_MAX_PROMPTS_PER_KEY, 2);
  });

  it("promptKey is surface:reason", () => {
    assert.equal(promptKey({ surface: "glass", reason: "tie_break" }), "glass:tie_break");
  });
});

describe("lib/bottle-flow — planNextFrame", () => {
  it("empty state, no frames: the front, asking for the brand", () => {
    assert.deepEqual(planNextFrame(input()), {
      surface: "front",
      frameType: "label",
      prompt: "Show the front of the bottle",
      hint: FRONT_BOX_HINT,
      reason: "need_brand",
      optional: false,
    });
  });

  it("brand known: the bottom, asking for the name", () => {
    assert.deepEqual(planNextFrame(input({ brandKnown: true, frameCount: 1 })), {
      surface: "bottom",
      frameType: "label",
      prompt: "Now the bottom",
      reason: "need_name",
      optional: false,
    });
  });

  it("name read, candidates, no glass hex yet: an optional glass photo", () => {
    assert.deepEqual(
      planNextFrame(input({ brandKnown: true, nameRead: true, decision: "candidates", frameCount: 2, surfaces: { bottom: 1 } })),
      {
        surface: "glass",
        frameType: "color",
        prompt: "Turn it so we see the color",
        reason: "need_color",
        optional: true,
      }
    );
  });

  it("candidates with a glass hex already: the box for its barcode, then nothing more to ask", () => {
    const base = { brandKnown: true, nameRead: true, glassHex: true, decision: "candidates", frameCount: 3, surfaces: { bottom: 1, glass: 1 } };
    assert.deepEqual(planNextFrame(input(base)), {
      surface: "box",
      frameType: "label",
      prompt: "Have the box? Show the barcode",
      reason: "need_name",
      optional: true,
    });
    assert.equal(planNextFrame(input({ ...base, gtinRead: true })), null, "a barcode already read: no box");
    assert.equal(planNextFrame(input({ ...base, state: withState({ skipped: ["box"] }) })), null, "box skipped");
    assert.equal(planNextFrame(input({ ...base, surfaces: { ...base.surfaces, box: 1 } })), null, "box photographed");
  });

  it("a tie asks for the glass again, with the first hint, then the second, then stops", () => {
    const tied = {
      brandKnown: true,
      nameRead: true,
      glassHex: true,
      gtinRead: true,
      decision: "candidates_tied",
      frameCount: 3,
      surfaces: { bottom: 1, glass: 1 },
    };
    const first = planNextFrame(input(tied));
    assert.equal(first.surface, "glass");
    assert.equal(first.reason, "tie_break");
    assert.equal(first.hint, "Tilt it toward the light");
    assert.equal(first.optional, true);
    assert.equal(first.frameType, "color");

    const second = planNextFrame(input({ ...tied, state: withState({ prompts: { "glass:tie_break": 1 } }) }));
    assert.equal(second.hint, "Hold it against something white");

    assert.equal(planNextFrame(input({ ...tied, state: withState({ prompts: { "glass:tie_break": 2 } }) })), null);
  });

  it("a barcode match asks for nothing", () => {
    assert.equal(planNextFrame(input({ decision: "barcode_matched", frameCount: 1, surfaces: { box: 1 }, gtinRead: true })), null);
    assert.equal(planNextFrame(input({ decision: "barcode_matched", brandKnown: true, frameCount: 1 })), null);
  });

  it("a name match keeps walking: the glass, then the box, then nothing", () => {
    const matched = { decision: "matched", brandKnown: true, nameRead: true, frameCount: 1, surfaces: { bottom: 1 } };
    assert.equal(planNextFrame(input(matched)).surface, "glass");
    assert.equal(planNextFrame(input({ ...matched, frameCount: 2, glassHex: true, surfaces: { bottom: 1, glass: 1 } })).surface, "box");
    assert.equal(
      planNextFrame(input({ ...matched, frameCount: 3, glassHex: true, surfaces: { bottom: 1, glass: 1, box: 1 } })),
      null
    );
  });

  it("a name match from a front photo still asks for the bottom", () => {
    assert.equal(
      planNextFrame(input({ decision: "matched", brandKnown: true, nameRead: true, frameCount: 1, surfaces: { front: 1 } })).surface,
      "bottom"
    );
  });

  it("create_card and unmatched with every photo taken ask for nothing", () => {
    for (const decision of ["create_card", "unmatched"]) {
      assert.equal(
        planNextFrame(input({ decision, brandKnown: true, nameRead: true, frameCount: 3, surfaces: { bottom: 1, glass: 1, box: 1 } })),
        null
      );
    }
  });

  describe("retry_quality", () => {
    const rejected = { surface: "bottom", warning: "blurry" };

    it("repeats a surface that produced no evidence, with the warning's hint", () => {
      const spec = planNextFrame(
        input({
          state: withState({ lastRejected: rejected }),
          surfaces: { bottom: 1 },
          brandKnown: true,
          nameRead: false,
          frameCount: 1,
        })
      );
      assert.deepEqual(spec, {
        surface: "bottom",
        frameType: "label",
        prompt: "Now the bottom",
        hint: "Looks blurry — hold steady and tap to focus",
        reason: "retry_quality",
        optional: false,
      });
    });

    it("never repeats a surface that produced evidence", () => {
      const spec = planNextFrame(
        input({
          state: withState({ lastRejected: rejected }),
          surfaces: { bottom: 1 },
          brandKnown: true,
          nameRead: true,
          decision: "candidates",
          glassHex: true,
          gtinRead: true,
          surfaces: { bottom: 1, glass: 1 },
          frameCount: 2,
        })
      );
      assert.equal(spec, null);
    });

    it("judges each surface by the evidence it can produce", () => {
      const base = { surfaces: { bottom: 1, glass: 1 }, brandKnown: true, nameRead: true, gtinRead: true, decision: "candidates", frameCount: 2 };
      const glassBlurry = withState({ lastRejected: { surface: "glass", warning: "too-dark" } });
      assert.equal(planNextFrame(input({ ...base, state: glassBlurry, glassHex: false })).reason, "retry_quality");
      assert.equal(planNextFrame(input({ ...base, state: glassBlurry, glassHex: true })), null);
      const frontBlurry = withState({ lastRejected: { surface: "front", warning: "too-bright" } });
      const front = planNextFrame(input({ surfaces: { front: 1 }, state: frontBlurry, frameCount: 1 }));
      assert.equal(front.reason, "retry_quality");
      assert.equal(front.hint, "Too bright — move out of the glare");
      assert.equal(
        planNextFrame(input({ surfaces: { front: 1 }, state: frontBlurry, brandKnown: true, decision: "matched", frameCount: 1 })).reason,
        "need_name",
        "the front read its brand: no retry, on to the bottom"
      );
    });

    it("never fires once a barcode matched, even for a poor frame that added nothing", () => {
      for (const surface of ["box", "front", "bottom", "glass"]) {
        const spec = planNextFrame(
          input({
            state: withState({ lastRejected: { surface, warning: "blurry" } }),
            surfaces: { [surface]: 1 },
            decision: "barcode_matched",
            frameCount: 1,
          })
        );
        assert.equal(spec, null, surface);
      }
    });

    it("is capped like any other prompt and honours a skip", () => {
      const common = { surfaces: { bottom: 1 }, brandKnown: true, nameRead: false, frameCount: 1 };
      const capped = withState({ lastRejected: rejected, prompts: { "bottom:retry_quality": 2 } });
      // Falls through to the ordinary bottom/need_name ask.
      assert.equal(planNextFrame(input({ ...common, state: capped })).reason, "need_name");
      const skipped = withState({ lastRejected: rejected, skipped: ["bottom"] });
      // The bottom skipped and no name: the glass color is the evidence left to ask for.
      const next = planNextFrame(input({ ...common, state: skipped }));
      assert.equal(next.surface, "glass");
      assert.equal(next.reason, "need_color");
    });

    it("a blurry box frame whose barcode was read (matched or not) is not asked again", () => {
      const box = withState({ lastRejected: { surface: "box", warning: "blurry" } });
      const withGtin = planNextFrame(input({ state: box, surfaces: { box: 1 }, frameCount: 1, gtinRead: true }));
      assert.notEqual(withGtin?.reason, "retry_quality");
      const withoutGtin = planNextFrame(input({ state: box, surfaces: { box: 1 }, frameCount: 1 }));
      assert.equal(withoutGtin.reason, "retry_quality");
      assert.equal(withoutGtin.surface, "box");
    });
  });

  it("stops at the frame cap", () => {
    assert.equal(planNextFrame(input({ frameCount: 6 })), null);
    assert.equal(planNextFrame(input({ frameCount: 7, brandKnown: true })), null);
    assert.ok(planNextFrame(input({ frameCount: 5 })));
  });

  it("skipping the front asks for the box", () => {
    const spec = planNextFrame(input({ state: withState({ skipped: ["front"] }), frameCount: 1 }));
    assert.deepEqual(spec, {
      surface: "box",
      frameType: "label",
      prompt: "Have the box? Show the barcode",
      reason: "need_brand",
      optional: true,
    });
  });

  it("a front photo that read no brand is asked for twice, then the box", () => {
    const base = { surfaces: { front: 1 }, frameCount: 1 };
    assert.equal(planNextFrame(input({ ...base, state: withState({ prompts: { "front:need_brand": 1 } }) })).surface, "front");
    assert.equal(planNextFrame(input({ ...base, state: withState({ prompts: { "front:need_brand": 2 } }) })).surface, "box");
  });

  it("every surface skipped and no brand: the box, and with the box skipped nothing (review focus 5)", () => {
    const skipped = ["front", "bottom", "glass"];
    const spec = planNextFrame(input({ state: withState({ skipped }), frameCount: 2 }));
    assert.equal(spec.surface, "box");
    assert.equal(spec.reason, "need_brand");
    assert.equal(planNextFrame(input({ state: withState({ skipped: [...skipped, "box"] }), frameCount: 2 })), null);
  });

  it("no frames and front and box skipped: falls back to the default order", () => {
    const spec = planNextFrame(input({ state: withState({ skipped: ["front", "box"] }) }));
    assert.equal(spec.surface, "bottom");
    assert.equal(spec.reason, "need_name");
    const glass = planNextFrame(input({ state: withState({ skipped: ["front", "box", "bottom"] }) }));
    assert.equal(glass.surface, "glass");
    assert.equal(glass.reason, "need_color");
    assert.equal(glass.optional, true);
  });

  it("with frames already taken the default-order fallback still applies", () => {
    const spec = planNextFrame(input({ state: withState({ skipped: ["front", "box"] }), surfaces: { front: 1 }, frameCount: 1 }));
    assert.equal(spec.surface, "bottom");
    assert.equal(spec.reason, "need_name");
  });

  it("no brand text, front asked twice and box skipped: the bottom, then the glass, then nothing", () => {
    let state = withState({ prompts: { "front:need_brand": 2 }, skipped: ["box"] });
    const surfaces = { front: 2 };
    const bottom = planNextFrame(input({ state, surfaces, frameCount: 2 }));
    assert.equal(bottom.surface, "bottom");
    assert.equal(bottom.reason, "need_name");
    state = recordPrompt(state, bottom);
    surfaces.bottom = 1; // photographed, read nothing
    const glass = planNextFrame(input({ state, surfaces, frameCount: 3 }));
    assert.equal(glass.surface, "glass");
    assert.equal(glass.reason, "need_color");
    assert.equal(glass.optional, true);
    state = recordPrompt(state, glass);
    surfaces.glass = 1;
    assert.equal(planNextFrame(input({ state, surfaces, frameCount: 4, glassHex: true })), null);
  });

  it("brand known, the bottom asked twice and no name read: the glass color before the create card", () => {
    const spec = planNextFrame(
      input({
        brandKnown: true,
        frameCount: 2,
        surfaces: { bottom: 2 },
        decision: "create_card",
        state: withState({ prompts: { "bottom:need_name": 2 } }),
      })
    );
    assert.equal(spec.surface, "glass");
    assert.equal(spec.reason, "need_color");
    assert.equal(
      planNextFrame(input({ brandKnown: true, frameCount: 3, surfaces: { bottom: 2, glass: 1 }, decision: "create_card", state: withState({ prompts: { "bottom:need_name": 2, "glass:need_color": 1 } }) })).surface,
      "box",
      "the glass was photographed: the box"
    );
  });

  it("a name read without a catalog match still walks the glass and the box before the create card", () => {
    const base = { brandKnown: true, nameRead: true, frameCount: 1, surfaces: { bottom: 1 }, decision: "create_card" };
    assert.equal(planNextFrame(input(base)).surface, "glass");
    assert.equal(planNextFrame(input({ ...base, frameCount: 2, glassHex: true, surfaces: { bottom: 1, glass: 1 } })).surface, "box");
  });
});

describe("lib/bottle-flow — state helpers", () => {
  it("recordPrompt increments the key and leaves the input alone", () => {
    const spec = planNextFrame(input());
    const once = recordPrompt(EMPTY, spec);
    const twice = recordPrompt(once, spec);
    assert.deepEqual(once.prompts, { "front:need_brand": 1 });
    assert.deepEqual(twice.prompts, { "front:need_brand": 2 });
    assert.deepEqual(EMPTY.prompts, {});
  });

  it("recordSkip adds a surface once", () => {
    const once = recordSkip(EMPTY, "bottom");
    assert.deepEqual(once.skipped, ["bottom"]);
    assert.deepEqual(recordSkip(once, "bottom").skipped, ["bottom"]);
    assert.deepEqual(EMPTY.skipped, []);
  });

  it("recordRejected sets and clears lastRejected", () => {
    const rejected = { surface: "glass", warning: "too-dark" };
    const set = recordRejected(EMPTY, rejected);
    assert.deepEqual(set.lastRejected, rejected);
    assert.equal(recordRejected(set, null).lastRejected, null);
  });

  it("readBottleFlowState reads what the patch wrote and tolerates junk", () => {
    assert.deepEqual(readBottleFlowState(null), EMPTY);
    assert.deepEqual(readBottleFlowState({}), EMPTY);
    assert.deepEqual(readBottleFlowState({ bottle: "nope" }), EMPTY);
    assert.deepEqual(
      readBottleFlowState({
        bottle: {
          prompts: { "front:need_brand": 1, "bottom:need_name": "x", "glass:need_color": -2, "box:need_brand": 1.5 },
          skipped: ["bottom", "cap", "bottom", 4],
          lastRejected: { surface: "glass", warning: "blurry" },
        },
      }),
      { prompts: { "front:need_brand": 1 }, skipped: ["bottom"], lastRejected: { surface: "glass", warning: "blurry" } }
    );
    assert.equal(readBottleFlowState({ bottle: { lastRejected: { surface: "cap", warning: "blurry" } } }).lastRejected, null);
    assert.equal(readBottleFlowState({ bottle: { lastRejected: { surface: "glass", warning: "grainy" } } }).lastRejected, null);
  });

  it("bottleFlowMetadataPatch writes the counters and the last ask, and keeps the brand", () => {
    const spec = planNextFrame(input({ brandKnown: true, frameCount: 1 }));
    const state = recordSkip(recordPrompt(EMPTY, spec), "glass");
    const brand = { brandId: "3", name: "Loud Lacquer", source: "hint", raw: "loud" };
    const patch = bottleFlowMetadataPatch(state, spec, { brand });
    assert.deepEqual(patch, {
      bottle: {
        brand,
        prompts: { "bottom:need_name": 1 },
        skipped: ["glass"],
        lastRejected: null,
        lastNextFrame: spec,
      },
    });
    assert.deepEqual(bottleFlowMetadataPatch(EMPTY, null).bottle.lastNextFrame, null);
    // The existing bottle object wins only for keys the flow does not own.
    assert.equal(bottleFlowMetadataPatch(EMPTY, null, { prompts: { x: 9 }, extra: 1 }).bottle.prompts.x, undefined);
    assert.equal(bottleFlowMetadataPatch(EMPTY, null, { extra: 1 }).bottle.extra, 1);
  });

  it("readLastNextFrame returns the stored ask or null", () => {
    const spec = planNextFrame(input());
    assert.deepEqual(readLastNextFrame(bottleFlowMetadataPatch(EMPTY, spec)), spec);
    assert.equal(readLastNextFrame(bottleFlowMetadataPatch(EMPTY, null)), null);
    assert.equal(readLastNextFrame(null), null);
    assert.equal(readLastNextFrame({ bottle: { lastNextFrame: { surface: "cap" } } }), null);
    assert.equal(readLastNextFrame({ bottle: { lastNextFrame: "front" } }), null);
  });
});

describe("lib/bottle-flow — decisionForPlan", () => {
  const candidates = [{ entityType: "shade", entityId: 1, shadeId: 1, display: "A", confidence: 0.8 }];
  const question = { key: "candidate_select", prompt: "Which one?", type: "single_select" };

  it("matched → matched, or barcode_matched when the barcode matched", () => {
    const matched = { status: "matched", confidence: 1, entityType: "shade", entityId: 1, candidates, metadataPatch: {} };
    assert.equal(decisionForPlan(matched), "matched");
    assert.equal(decisionForPlan({ ...matched, barcodeVia: "catalog" }), "barcode_matched");
  });

  it("candidates to choose from → candidates, or candidates_tied on a tie", () => {
    const base = { status: "needs_question", confidence: 0.8, question, candidates, metadataPatch: {} };
    assert.equal(decisionForPlan({ ...base, bottle: { brand: null, tie: false, modelCalls: 0 } }), "candidates");
    assert.equal(decisionForPlan({ ...base, bottle: { brand: null, tie: true, modelCalls: 0 } }), "candidates_tied");
    assert.equal(decisionForPlan(base), "candidates");
  });

  it("the awaiting-frames question is none", () => {
    assert.equal(
      decisionForPlan({
        status: "needs_question",
        confidence: 0,
        question: { key: "capture_frame", prompt: "p", type: "text" },
        candidates: [],
        metadataPatch: { resolver: { step: "awaiting_frames" } },
      }),
      "none"
    );
  });

  it("other questions are unmatched", () => {
    assert.equal(
      decisionForPlan({
        status: "needs_question",
        confidence: 0,
        question: { key: "brand_shade", prompt: "p", type: "text" },
        candidates: [],
        metadataPatch: {},
      }),
      "unmatched"
    );
  });

  it("unmatched with a suggested shade is create_card, without is unmatched", () => {
    const suggestedShade = { brandId: "3", brandName: "B", brandSource: "hint", shadeName: "S", hex: null, finish: null, gtin: null };
    assert.equal(
      decisionForPlan({ status: "unmatched", confidence: 0, candidates: [], metadataPatch: {}, bottle: { brand: null, suggestedShade, tie: false, modelCalls: 0 } }),
      "create_card"
    );
    assert.equal(decisionForPlan({ status: "unmatched", confidence: 0, candidates: [], metadataPatch: {} }), "unmatched");
  });
});
