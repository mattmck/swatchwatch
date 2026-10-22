import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  HARMONY_TYPES,
  generateHarmonyColors,
  generateHarmonyPalette,
  getHarmonyTypeOptions,
  suggestPaletteCompletion,
} from "./harmonies";
import { colorDistance } from "./oklab";
import { hexToOklch } from "./color-family";

// Golden values recorded from the web implementation (apps/web/src/lib/color-harmonies.ts)
// before it moved here, so the move is provably behaviour-preserving.
const BLUE = "#1F4E9C";
const BLUE_PALETTES: Record<string, string[]> = {
  similar: ["#1F4E9C"],
  complementary: ["#1F4E9C", "#784500"],
  "split-complementary": ["#1F4E9C", "#8a3300", "#585600"],
  analogous: ["#1F4E9C", "#005c8e", "#533f97"],
  triadic: ["#1F4E9C", "#8e2731", "#1d6306"],
  tetradic: ["#1F4E9C", "#86295c", "#784500", "#006846"],
  monochromatic: ["#00004f", "#002b76", "#1F4E9C", "#4172c3", "#679aef"],
};

describe("generateHarmonyPalette", () => {
  it("matches the recorded web palettes for every harmony", () => {
    for (const { value } of HARMONY_TYPES) {
      assert.deepEqual(generateHarmonyPalette(BLUE, value), BLUE_PALETTES[value], value);
    }
  });

  it("uppercases the source and keeps it first", () => {
    assert.equal(generateHarmonyPalette("#1f4e9c", "triadic")[0], "#1F4E9C");
  });

  it("does not rotate achromatic colors", () => {
    assert.deepEqual(generateHarmonyPalette("#808080", "complementary"), ["#808080", "#808080"]);
    assert.deepEqual(generateHarmonyPalette("#808080", "monochromatic"), [
      "#3a3a3a",
      "#5d5d5d",
      "#808080",
      "#a4a4a4",
      "#cdcdcd",
    ]);
  });

  it("keeps roughly the source lightness on hue rotations (per-channel gamut clipping drifts it a little)", () => {
    const sourceL = hexToOklch(BLUE).L;
    for (const hex of generateHarmonyColors(BLUE, "tetradic")) {
      assert.ok(Math.abs(hexToOklch(hex).L - sourceL) < 0.05, hex);
    }
  });

  it("puts the complement about 180° away (± gamut clipping) on the OKLCH wheel", () => {
    const [, complement] = generateHarmonyPalette("#C0392B", "complementary");
    const delta = Math.abs(hexToOklch(complement).h - hexToOklch("#C0392B").h);
    assert.ok(Math.abs(delta - 180) < 15, `hue delta ${delta}`);
  });
});

describe("generateHarmonyColors", () => {
  it("drops the source, and returns nothing for similar", () => {
    assert.deepEqual(generateHarmonyColors(BLUE, "analogous"), BLUE_PALETTES.analogous.slice(1));
    assert.deepEqual(generateHarmonyColors(BLUE, "similar"), []);
  });
});

describe("suggestPaletteCompletion", () => {
  it("needs two valid, distinct anchors", () => {
    assert.equal(suggestPaletteCompletion([]), null);
    assert.equal(suggestPaletteCompletion(["#C0392B"]), null);
    assert.equal(suggestPaletteCompletion(["#C0392B", "#c0392b", "nope"]), null);
  });

  it("matches the recorded web suggestion", () => {
    assert.deepEqual(suggestPaletteCompletion(["#C0392B", "#2BB2C0"]), {
      harmony: "analogous",
      confidence: 0.72,
      anchors: ["#C0392B", "#2BB2C0"],
      sourceHex: "#2BB2C0",
      targetHexes: ["#2BB2C0", "#40b59c", "#51a9da"],
      completionHexes: [],
    });
  });

  it("detects a complementary pair and completes nothing", () => {
    const [source, complement] = generateHarmonyPalette("#C0392B", "complementary");
    const suggestion = suggestPaletteCompletion([source, complement]);
    assert.ok(suggestion);
    assert.ok(suggestion.confidence > 0.9);
    for (const hex of suggestion.targetHexes) {
      assert.ok(Math.min(colorDistance(hex, source), colorDistance(hex, complement.toUpperCase())) < 0.08);
    }
  });
});

describe("getHarmonyTypeOptions", () => {
  it("falls back to HARMONY_TYPES", () => {
    assert.equal(getHarmonyTypeOptions(), HARMONY_TYPES);
    assert.equal(getHarmonyTypeOptions([]), HARMONY_TYPES);
  });

  it("keeps known names, sorts by sortOrder then label, and falls back to built-in labels", () => {
    const base = { description: null, createdAt: "", updatedAt: "" };
    const options = getHarmonyTypeOptions([
      { ...base, harmonyTypeId: 1, name: "triadic", displayName: "Three-way", sortOrder: 2 },
      { ...base, harmonyTypeId: 2, name: "made-up", displayName: "Nope", sortOrder: 0 },
      { ...base, harmonyTypeId: 3, name: "complementary", displayName: "", sortOrder: 1 },
    ] as unknown as Parameters<typeof getHarmonyTypeOptions>[0]);
    assert.deepEqual(options, [
      { value: "complementary", label: "Complementary" },
      { value: "triadic", label: "Three-way" },
    ]);
  });
});
