import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BottleEvalValidationError, validateBottleEvalSampleInput } from "./bottle-eval";
import { BOTTLE_SURFACE_FRAME_TYPE, parseBottleSurface } from "../index";

describe("validateBottleEvalSampleInput", () => {
  it("accepts a catalog shade id, trimmed, with null notes", () => {
    assert.deepEqual(validateBottleEvalSampleInput({ shadeId: " 42 " }), {
      kind: "catalog",
      shadeId: "42",
      notes: null,
    });
  });

  it("accepts a positive integer shade id as its string form", () => {
    assert.deepEqual(validateBottleEvalSampleInput({ shadeId: 42 }), {
      kind: "catalog",
      shadeId: "42",
      notes: null,
    });
  });

  it("accepts brand and shade text for a bottle not in the catalog", () => {
    assert.deepEqual(
      validateBottleEvalSampleInput({ brandText: " Loud Lacquer ", shadeText: "Howl", notes: "x" }),
      { kind: "external", brandText: "Loud Lacquer", shadeText: "Howl", notes: "x" },
    );
  });

  it("trims notes and turns blank notes into null", () => {
    assert.equal(validateBottleEvalSampleInput({ shadeId: "7", notes: "  dented cap  " }).notes, "dented cap");
    assert.equal(validateBottleEvalSampleInput({ shadeId: "7", notes: "   " }).notes, null);
  });

  it("accepts text and notes at the length limits", () => {
    const result = validateBottleEvalSampleInput({
      brandText: "b".repeat(200),
      shadeText: "s".repeat(200),
      notes: "n".repeat(1000),
    });
    assert.equal(result.kind, "external");
  });

  const invalid: Array<[string, unknown]> = [
    ["an empty body", {}],
    ["both a shade id and text", { shadeId: "42", brandText: "a", shadeText: "b" }],
    ["a non-numeric shade id", { shadeId: "abc" }],
    ["a zero shade id", { shadeId: 0 }],
    ["a fractional shade id", { shadeId: 1.5 }],
    ["a negative shade id", { shadeId: -3 }],
    ["brand text without shade text", { brandText: "a" }],
    ["shade text without brand text", { shadeText: "b" }],
    ["blank brand text", { brandText: "  ", shadeText: "b" }],
    ["brand text over 200 chars", { brandText: "a".repeat(201), shadeText: "b" }],
    ["shade text over 200 chars", { brandText: "a", shadeText: "b".repeat(201) }],
    ["notes over 1000 chars", { shadeId: "42", notes: "n".repeat(1001) }],
    ["non-string notes", { shadeId: "42", notes: 5 }],
    ["non-string brand text", { brandText: 1, shadeText: "b" }],
    ["null", null],
    ["a string", "string"],
    ["an array", [{ shadeId: "42" }]],
  ];

  for (const [label, body] of invalid) {
    it(`rejects ${label}`, () => {
      assert.throws(() => validateBottleEvalSampleInput(body), BottleEvalValidationError);
    });
  }
});

describe("parseBottleSurface", () => {
  it("accepts each known surface", () => {
    assert.equal(parseBottleSurface("glass"), "glass");
    assert.equal(parseBottleSurface("front"), "front");
    assert.equal(parseBottleSurface("bottom"), "bottom");
    assert.equal(parseBottleSurface("box"), "box");
  });

  it("returns null for anything else", () => {
    for (const value of ["GLASS", "cap", 1, null, undefined]) {
      assert.equal(parseBottleSurface(value), null);
    }
  });
});

describe("BOTTLE_SURFACE_FRAME_TYPE", () => {
  it("sends the glass as a color frame and every other surface as a label frame", () => {
    assert.deepEqual(BOTTLE_SURFACE_FRAME_TYPE, {
      front: "label",
      bottom: "label",
      glass: "color",
      box: "label",
    });
  });
});
