import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtractedColor, Polish, PolishMatch } from "swatchwatch-shared";
import {
  activeColorGroups,
  activePaletteColors,
  DEFAULT_PALETTE_SELECTION,
  formatFraction,
  hiddenByDefaultCount,
  matchPercent,
  normalizePaletteHex,
  paletteChipState,
  replaceMatchedPolish,
  togglePaletteColor,
} from "./photo-match";

const red: ExtractedColor = { hex: "#c01030", fraction: 0.5, kind: "color" };
const white: ExtractedColor = { hex: "#fafafa", fraction: 0.4, kind: "light" };
const skin: ExtractedColor = { hex: "#e0b090", fraction: 0.1, kind: "skin" };
const palette = [red, white, skin];

function polish(id: string, status: Polish["status"] = null): Polish {
  return { id, brand: "B", name: `N${id}`, status } as Polish;
}

function match(id: string, hex: string, distance = 0.05): PolishMatch {
  return { polish: polish(id), matchedColor: hex, distance, confidence: "high" };
}

describe("palette selection", () => {
  it("normalizes hexes", () => {
    assert.equal(normalizePaletteHex("c01030"), "#C01030");
    assert.equal(normalizePaletteHex("#zzz"), null);
  });

  it("hides background and skin by default unless the palette has no real color", () => {
    assert.deepEqual(activePaletteColors(palette, DEFAULT_PALETTE_SELECTION), [red]);
    assert.equal(hiddenByDefaultCount(palette, DEFAULT_PALETTE_SELECTION), 2);
    assert.deepEqual(activePaletteColors([white, skin], DEFAULT_PALETTE_SELECTION), [white, skin]);
    assert.deepEqual(activePaletteColors(palette, { ...DEFAULT_PALETTE_SELECTION, showAll: true }), palette);
  });

  it("toggles active → dropped → active, and hidden → kept", () => {
    let selection = togglePaletteColor("#C01030", palette, DEFAULT_PALETTE_SELECTION);
    assert.equal(paletteChipState(red, palette, selection), "dropped");
    selection = togglePaletteColor("c01030", palette, selection);
    assert.equal(paletteChipState(red, palette, selection), "active");
    selection = togglePaletteColor("#fafafa", palette, selection);
    assert.equal(paletteChipState(white, palette, selection), "active");
    selection = togglePaletteColor("#fafafa", palette, selection);
    assert.equal(paletteChipState(white, palette, selection), "dropped");
    selection = togglePaletteColor("#fafafa", palette, selection);
    assert.equal(paletteChipState(white, palette, selection), "active");
    assert.equal(togglePaletteColor("#000000", palette, selection), selection);
  });
});

describe("activeColorGroups", () => {
  it("keeps palette order for the active colors", () => {
    const groups = activeColorGroups(
      {
        matches: [],
        colorMatches: [
          { hex: "#FAFAFA", matches: [match("2", "#fafafa")] },
          { hex: "#C01030", matches: [match("1", "#c01030")] },
        ],
      },
      [red, white],
    );
    assert.deepEqual(groups.map((g) => g.hex), ["#C01030", "#FAFAFA"]);
  });

  it("groups the flat list when colorMatches is missing", () => {
    const groups = activeColorGroups({ matches: [match("1", "#C01030"), match("2", "#fafafa")] }, [red]);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].matches.map((m) => m.polish.id), ["1"]);
  });
});

describe("formatting and updates", () => {
  it("formats percents", () => {
    assert.equal(matchPercent(0), 100);
    assert.equal(matchPercent(0.25), 50);
    assert.equal(matchPercent(2), 0);
    assert.equal(formatFraction(0.004), "<1%");
    assert.equal(formatFraction(0.42), "42%");
  });

  it("replaces a polish in every group after a status change", () => {
    const groups = [
      { hex: "#C01030", matches: [match("1", "#C01030"), match("2", "#C01030")] },
      { hex: "#FAFAFA", matches: [match("1", "#FAFAFA")] },
    ];
    const next = replaceMatchedPolish(groups, polish("1", "wishlist"));
    assert.equal(next[0].matches[0].polish.status, "wishlist");
    assert.equal(next[0].matches[1].polish.status, null);
    assert.equal(next[1].matches[0].polish.status, "wishlist");
  });
});
