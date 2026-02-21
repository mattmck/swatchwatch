import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyHexToGapCell, gapCellToSeedHex } from "./color-utils";

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
