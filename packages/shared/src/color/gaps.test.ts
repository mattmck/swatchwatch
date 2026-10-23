import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  analyzeCollectionGaps,
  classifyHexToGapCell,
  gapCellKey,
  gapCellToSeedHex,
  HUE_FAMILY_ORDER,
  LIGHTNESS_BAND_ORDER,
  parseGapCellKey,
  recommendGapCells,
  sortGapCellsByGridOrder,
} from "./gaps";

describe("classifyHexToGapCell", () => {
  it("bins known colors", () => {
    assert.deepEqual(classifyHexToGapCell("#FFFFFF"), { hueFamily: "neutrals", lightnessBand: "light" });
    assert.deepEqual(classifyHexToGapCell("#000000"), { hueFamily: "neutrals", lightnessBand: "dark" });
    assert.equal(classifyHexToGapCell("#008B8B")?.hueFamily, "blues-teals");
    assert.equal(classifyHexToGapCell("#0000FF")?.hueFamily, "purples-violets");
    assert.equal(classifyHexToGapCell("#00AA00")?.hueFamily, "greens");
  });
  it("rejects invalid hexes", () => {
    assert.equal(classifyHexToGapCell("red"), null);
    assert.equal(classifyHexToGapCell("#FFF"), null);
  });
});

describe("gapCellToSeedHex", () => {
  it("seed hexes are valid and keep their lightness band (hue may clip for dark yellows, as on the web)", () => {
    for (const hueFamily of HUE_FAMILY_ORDER) {
      for (const lightnessBand of LIGHTNESS_BAND_ORDER) {
        const hex = gapCellToSeedHex(hueFamily, lightnessBand);
        assert.match(hex, /^#[0-9A-F]{6}$/);
        const cell = classifyHexToGapCell(hex);
        assert.ok(cell, hex);
        if (hueFamily === "neutrals") assert.deepEqual(cell, { hueFamily, lightnessBand });
      }
    }
  });
  it("most seeds classify back into their own cell", () => {
    assert.deepEqual(classifyHexToGapCell(gapCellToSeedHex("greens", "medium")), {
      hueFamily: "greens",
      lightnessBand: "medium",
    });
  });
});

describe("analyzeCollectionGaps", () => {
  it("lists all 40 cells, missing and thin", () => {
    const a = analyzeCollectionGaps(["#FF0000", "#FF0000", "#FF0000", "#FF0000", "#008B8B"]);
    assert.equal(a.cells.length, 40);
    assert.equal(a.cells.reduce((s, c) => s + c.count, 0), 5);
    assert.equal(a.missing.length, 38);
    assert.equal(a.underrepresented.length, 1);
    assert.equal(a.underrepresented[0].hueFamily, "blues-teals");
  });
  it("ignores invalid hexes in counts", () => {
    const a = analyzeCollectionGaps(["nope"]);
    assert.equal(a.missing.length, 40);
  });
});

describe("keys, order and recommendations", () => {
  it("round-trips keys", () => {
    const key = gapCellKey({ hueFamily: "greens", lightnessBand: "dark" });
    assert.deepEqual(parseGapCellKey(key), { hueFamily: "greens", lightnessBand: "dark" });
    assert.equal(parseGapCellKey("greens:nope"), null);
    assert.equal(parseGapCellKey("a:b:c"), null);
    assert.equal(parseGapCellKey(null), null);
  });
  it("sorts lightness row first", () => {
    const sorted = sortGapCellsByGridOrder([
      { hueFamily: "neutrals", lightnessBand: "dark", count: 0 },
      { hueFamily: "reds", lightnessBand: "light", count: 0 },
      { hueFamily: "greens", lightnessBand: "dark", count: 0 },
    ]);
    assert.deepEqual(sorted.map(gapCellKey), ["greens:dark", "neutrals:dark", "reds:light"]);
  });
  it("recommends missing first (grid order) then thin emptiest first", () => {
    const hexes = Array.from({ length: 80 }, () => "#FF0000").concat(["#008B8B"]);
    const rec = recommendGapCells(analyzeCollectionGaps(hexes), 3);
    assert.equal(rec.length, 3);
    assert.ok(rec.every((c) => c.count === 0));
    const all = recommendGapCells(analyzeCollectionGaps(hexes), 100);
    assert.equal(all[all.length - 1].count, 1);
  });
});
