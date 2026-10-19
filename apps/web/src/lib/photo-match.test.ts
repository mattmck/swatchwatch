import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ColorMatchGroup, ExtractedColor, MatchConfidence, PolishMatch } from "swatchwatch-shared";
import {
  activeColorGroups,
  activePaletteColors,
  confidenceCounts,
  DEFAULT_PALETTE_SELECTION,
  hiddenByDefaultCount,
  isHiddenByDefault,
  matchEmptyReason,
  normalizePaletteHex,
  paletteChipState,
  paletteColorKind,
  rankFlatMatches,
  togglePaletteColor,
} from "./photo-match";

function match(id: string, matchedColor: string, distance: number, confidence: MatchConfidence = "high", name = `Shade ${id}`): PolishMatch {
  return {
    polish: {
      id,
      shadeId: id,
      userId: "1",
      brand: "Brand",
      name,
      color: "",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    },
    matchedColor,
    distance,
    confidence,
  };
}

const RED = "#D01020";
const BLUE = "#1030C0";
const WHITE = "#FFFFFF";
const SKIN = "#E0AC69";

const palette: ExtractedColor[] = [
  { hex: WHITE, fraction: 0.4, kind: "light" },
  { hex: RED, fraction: 0.3, kind: "color" },
  { hex: SKIN, fraction: 0.2, kind: "skin" },
  { hex: BLUE, fraction: 0.1, kind: "color" },
];

describe("photo-match: palette selection", () => {
  it("normalizes hexes with or without #", () => {
    assert.equal(normalizePaletteHex("d01020"), RED);
    assert.equal(normalizePaletteHex(" #d01020 "), RED);
    assert.equal(normalizePaletteHex("red"), null);
    assert.equal(normalizePaletteHex(null), null);
  });

  it("uses the API kind, and classifies locally when an older response has none", () => {
    assert.equal(paletteColorKind({ hex: WHITE, kind: "color" }), "color");
    assert.equal(paletteColorKind({ hex: WHITE }), "light");
    assert.equal(paletteColorKind({ hex: SKIN }), "skin");
    assert.equal(paletteColorKind({ hex: RED }), "color");
  });

  it("hides background and skin colors by default", () => {
    assert.deepEqual(activePaletteColors(palette, DEFAULT_PALETTE_SELECTION).map((c) => c.hex), [RED, BLUE]);
    assert.equal(hiddenByDefaultCount(palette, DEFAULT_PALETTE_SELECTION), 2);
    assert.equal(paletteChipState(palette[0], palette, DEFAULT_PALETTE_SELECTION), "hidden");
  });

  it("never hides anything when the whole palette is background / skin", () => {
    const nudeOnWhite: ExtractedColor[] = [
      { hex: WHITE, fraction: 0.6, kind: "light" },
      { hex: SKIN, fraction: 0.4, kind: "skin" },
    ];
    assert.equal(isHiddenByDefault(nudeOnWhite[1], nudeOnWhite), false);
    assert.equal(activePaletteColors(nudeOnWhite, DEFAULT_PALETTE_SELECTION).length, 2);
  });

  it("show all brings the hidden colors back, but not dropped ones", () => {
    const selection = { showAll: true, drop: [BLUE], keep: [] };
    assert.deepEqual(activePaletteColors(palette, selection).map((c) => c.hex), [WHITE, RED, SKIN]);
    assert.equal(hiddenByDefaultCount(palette, selection), 0);
  });

  it("toggling an active chip drops it, toggling again restores it", () => {
    const dropped = togglePaletteColor("d01020", palette, DEFAULT_PALETTE_SELECTION);
    assert.deepEqual(dropped.drop, [RED]);
    assert.deepEqual(activePaletteColors(palette, dropped).map((c) => c.hex), [BLUE]);
    const restored = togglePaletteColor(RED, palette, dropped);
    assert.deepEqual(restored.drop, []);
    assert.deepEqual(activePaletteColors(palette, restored).map((c) => c.hex), [RED, BLUE]);
  });

  it("toggling a hidden chip keeps it; dropping and restoring it again stays kept", () => {
    const kept = togglePaletteColor(SKIN, palette, DEFAULT_PALETTE_SELECTION);
    assert.deepEqual(kept.keep, [SKIN]);
    assert.equal(paletteChipState(palette[2], palette, kept), "active");
    const dropped = togglePaletteColor(SKIN, palette, kept);
    assert.deepEqual(dropped, { showAll: false, drop: [SKIN], keep: [] });
    const back = togglePaletteColor(SKIN, palette, dropped);
    assert.equal(paletteChipState(palette[2], palette, back), "active");
  });

  it("ignores hexes that are not in the palette", () => {
    assert.equal(togglePaletteColor("#123456", palette, DEFAULT_PALETTE_SELECTION), DEFAULT_PALETTE_SELECTION);
    assert.equal(togglePaletteColor("nope", palette, DEFAULT_PALETTE_SELECTION), DEFAULT_PALETTE_SELECTION);
  });
});

describe("photo-match: ranking", () => {
  const groups: ColorMatchGroup[] = [
    { hex: WHITE, matches: [match("w", WHITE, 0.01)] },
    { hex: RED, matches: [match("a", RED, 0.03), match("b", RED, 0.07, "medium"), match("c", RED, 0.2, "low")] },
    { hex: SKIN, matches: [match("s", SKIN, 0.02)] },
    // "b" is closer to blue than to red; "x" only appears for blue.
    { hex: BLUE, matches: [match("x", BLUE, 0.01), match("b", BLUE, 0.04)] },
  ];

  it("keeps groups of active colors in palette order", () => {
    const active = activePaletteColors(palette, DEFAULT_PALETTE_SELECTION);
    assert.deepEqual(activeColorGroups(groups, active).map((g) => g.hex), [RED, BLUE]);
  });

  it("flat list keeps each polish's closest active color and sorts by grade, then photo share, then distance", () => {
    const active = activePaletteColors(palette, DEFAULT_PALETTE_SELECTION);
    const flat = rankFlatMatches(groups, active, 10);
    // High: a (red, 30% of photo) before x (blue, 10%) and b (blue, closer than its red match);
    // the red share wins over x's smaller distance.
    assert.deepEqual(
      flat.map((m) => `${m.polish.id}:${m.matchedColor}`),
      [`a:${RED}`, `x:${BLUE}`, `b:${BLUE}`, `c:${RED}`]
    );
    assert.equal(flat.find((m) => m.polish.id === "b")?.distance, 0.04);
  });

  it("drops a color's polishes when its chip is dropped, and respects the limit", () => {
    const selection = togglePaletteColor(BLUE, palette, DEFAULT_PALETTE_SELECTION);
    const flat = rankFlatMatches(groups, activePaletteColors(palette, selection), 2);
    assert.deepEqual(flat.map((m) => m.polish.id), ["a", "b"]);
    assert.equal(flat[1].matchedColor, RED);
  });

  it("counts confidence grades", () => {
    assert.deepEqual(confidenceCounts(groups[1].matches), { high: 1, medium: 1, low: 1 });
  });
});

describe("photo-match: empty state reason", () => {
  const base = { paletteSize: 3, candidateCount: 5, activeColorCount: 2, matches: [match("a", RED, 0.01)] };

  it("explains each empty case in priority order", () => {
    assert.equal(matchEmptyReason({ ...base, paletteSize: 0 }), "no-colors");
    assert.equal(matchEmptyReason({ ...base, candidateCount: 0 }), "no-candidates");
    assert.equal(matchEmptyReason({ ...base, activeColorCount: 0 }), "no-active-colors");
    assert.equal(matchEmptyReason({ ...base, matches: [match("a", RED, 0.3, "low")] }), "only-loose");
    assert.equal(matchEmptyReason(base), null);
  });
});
