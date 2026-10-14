import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyHexToGapCell,
  colorDistance,
  gapCellToSeedHex,
  hexToOklab,
  hexToRgb,
  oklabDistance,
  rgbToOklab,
} from "./color-utils";

describe("gapCellToSeedHex", () => {
  it("returns valid 6-digit hex output", () => {
    const hex = gapCellToSeedHex("greens", "medium");
    assert.match(hex, /^#[0-9a-f]{6}$/i);
  });

  it("round-trips through classifyHexToGapCell for lightness bands", () => {
    const cases = [
      ["reds", "dark"],
      ["blues-teals", "dark-medium"],
      ["greens", "medium"],
      ["pinks-magentas", "medium-light"],
      ["yellows-golds", "light"],
    ] as const;

    for (const [hueFamily, lightnessBand] of cases) {
      const hex = gapCellToSeedHex(hueFamily, lightnessBand);
      const classified = classifyHexToGapCell(hex);
      assert.ok(classified);
      assert.equal(classified?.lightnessBand, lightnessBand);
    }
  });

  it("uses neutral chroma so neutral seeds classify as neutrals", () => {
    const hex = gapCellToSeedHex("neutrals", "medium");
    const classified = classifyHexToGapCell(hex);
    assert.ok(classified);
    assert.equal(classified?.hueFamily, "neutrals");
  });
});

describe("colorDistance (re-exported from swatchwatch-shared)", () => {
  // Pinned to the values produced before the OKLAB math moved to shared.
  const pinned = [
    ["#FFFFFF", "#000000", 0.9999999934735468],
    ["#D01020", "#D11121", 0.0023739654423271216],
    ["#1030C0", "#1838B8", 0.02035764616527137],
    ["#C8A27C", "#98FF98", 0.24239714736904028],
    ["#FF0000", "#00FF00", 0.5198128892674524],
  ] as const;

  for (const [a, b, expected] of pinned) {
    it(`colorDistance(${a}, ${b}) is unchanged`, () => {
      assert.equal(colorDistance(a, b), expected);
      assert.equal(oklabDistance(hexToOklab(a), rgbToOklab(hexToRgb(b))), expected);
    });
  }
});
