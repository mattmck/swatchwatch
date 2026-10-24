import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  analyzeCollectionGaps,
  classifyHexToGapCell,
  gapCellKey,
  GAP_HUE_META,
  gapCellToSeedHex,
  HUE_FAMILY_ORDER,
  LIGHTNESS_BAND_ORDER,
  parseGapCellKey,
  recommendGapCells,
  sortGapCellsByGridOrder,
} from "./gaps";
import { clampChromaToSrgb, clampOklchToSrgb, isOklchInSrgb } from "./gamut";
import { classifyHexColorFamily, hexToOklch } from "./color-family";

const GAP_LIGHTNESS_SEED_FOR_TEST = { dark: 0.24, "dark-medium": 0.38, medium: 0.52, "medium-light": 0.7, light: 0.86 } as const;

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
  // Gap hue families are coarser/different from product color families (the "yellows-golds" hue
  // range 40-80 is orange/brown/nude in OKLCH), so classifyColorFamily is asserted against these
  // allowed sets rather than equality; the cell round trip below is the real contract.
  const ALLOWED_COLOR_FAMILIES: Record<string, string[]> = {
    reds: ["red", "pink"],
    "oranges-corals": ["red", "coral", "orange", "nude"],
    "yellows-golds": ["brown", "nude", "orange", "yellow"],
    greens: ["green"],
    "blues-teals": ["blue", "teal"],
    "purples-violets": ["blue", "purple"],
    "pinks-magentas": ["purple", "pink"],
    neutrals: ["black", "grey", "white"],
  };

  it("every cell's seed is a valid in-gamut hex that classifies back into its own cell", () => {
    for (const hueFamily of HUE_FAMILY_ORDER) {
      for (const lightnessBand of LIGHTNESS_BAND_ORDER) {
        const hex = gapCellToSeedHex(hueFamily, lightnessBand);
        assert.match(hex, /^#[0-9A-F]{6}$/, `${hueFamily}:${lightnessBand}`);
        assert.deepEqual(classifyHexToGapCell(hex), { hueFamily, lightnessBand }, `${hueFamily}:${lightnessBand} ${hex}`);
        const family = classifyHexColorFamily(hex);
        assert.ok(
          ALLOWED_COLOR_FAMILIES[hueFamily].includes(family as string),
          `${hueFamily}:${lightnessBand} ${hex} -> ${family}`,
        );
      }
    }
  });

  it("keeps the band's lightness and the family's hue (chroma is what gets clamped)", () => {
    for (const hueFamily of HUE_FAMILY_ORDER) {
      const hue = GAP_HUE_META[hueFamily].hue;
      if (hue === null) continue;
      for (const lightnessBand of LIGHTNESS_BAND_ORDER) {
        const hex = gapCellToSeedHex(hueFamily, lightnessBand);
        const { L, C, h } = hexToOklch(hex);
        assert.ok(Math.abs(L - GAP_LIGHTNESS_SEED_FOR_TEST[lightnessBand]) < 0.01, `${hex} L=${L}`);
        assert.ok(C > 0.04, `${hex} stays chromatic, C=${C}`);
        const dh = Math.min(Math.abs(h - hue), 360 - Math.abs(h - hue));
        assert.ok(dh < 3, `${hex} hue ${h} vs ${hue}`);
      }
    }
  });

  it("dark yellows-golds keeps its hue instead of clipping toward orange", () => {
    const hex = gapCellToSeedHex("yellows-golds", "dark");
    assert.deepEqual(classifyHexToGapCell(hex), { hueFamily: "yellows-golds", lightnessBand: "dark" });
    assert.ok(Math.abs(hexToOklch(hex).h - 52) < 3);
  });

  it("neutral seeds are achromatic", () => {
    for (const lightnessBand of LIGHTNESS_BAND_ORDER) {
      const hex = gapCellToSeedHex("neutrals", lightnessBand);
      assert.deepEqual(classifyHexToGapCell(hex), { hueFamily: "neutrals", lightnessBand });
    }
  });
});

describe("clampOklchToSrgb", () => {
  it("leaves in-gamut colors untouched", () => {
    assert.equal(clampChromaToSrgb(0.6, 0.05, 130), 0.05);
  });
  it("lowers chroma of out-of-gamut colors into gamut keeping L and h", () => {
    const lab = clampOklchToSrgb(0.24, 0.09, 52);
    assert.ok(isOklchInSrgb(0.24, Math.hypot(lab.a, lab.b), 52));
    assert.ok(Math.hypot(lab.a, lab.b) < 0.09);
    assert.equal(lab.L, 0.24);
    const wild = clampChromaToSrgb(0.5, 0.4, 330);
    assert.ok(wild > 0 && wild < 0.4 && isOklchInSrgb(0.5, wild, 330));
  });
  it("gives zero chroma at black, white and for non-positive chroma", () => {
    assert.equal(clampChromaToSrgb(0, 0.1, 10), 0);
    assert.equal(clampChromaToSrgb(1, 0.1, 10), 0);
    assert.equal(clampChromaToSrgb(0.5, -1, 10), 0);
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
