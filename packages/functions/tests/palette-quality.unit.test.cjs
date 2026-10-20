const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  classifyPaletteColor,
  isBackgroundPaletteKind,
  paletteVibrancyWeight,
} = require("swatchwatch-shared");

describe("swatchwatch-shared — classifyPaletteColor (#105)", () => {
  for (const [hex, kind] of [
    ["#FFFFFF", "light"],
    ["#F4F4F0", "light"], // off-white paper
    ["#FFFDF5", "light"], // very pale cream
    ["#000000", "dark"],
    ["#141418", "dark"],
    ["#FFDBAC", "skin"], // fair
    ["#E0AC69", "skin"],
    ["#C68642", "skin"],
    ["#8D5524", "skin"], // deep
    ["#E8B4A0", "skin"], // pinkish
    ["#D01020", "color"], // red polish
    ["#1030C0", "color"], // blue
    ["#2E8B57", "color"], // green
    ["#FF69B4", "color"], // hot pink
    ["#808080", "color"], // mid grey is not background
    ["#1A0B3D", "color"], // dark but saturated navy/purple
    ["not a hex", "color"],
  ]) {
    it(`${hex} → ${kind}`, () => {
      assert.equal(classifyPaletteColor(hex), kind);
    });
  }

  it("treats light and dark as background", () => {
    assert.equal(isBackgroundPaletteKind("light"), true);
    assert.equal(isBackgroundPaletteKind("dark"), true);
    assert.equal(isBackgroundPaletteKind("skin"), false);
    assert.equal(isBackgroundPaletteKind("color"), false);
  });

  it("weights saturated colors up to 2x and greys at 1x", () => {
    assert.ok(Math.abs(paletteVibrancyWeight("#808080") - 1) < 1e-3);
    assert.ok(paletteVibrancyWeight("#D01020") > 1.9);
    assert.equal(paletteVibrancyWeight("bad"), 1);
  });
});
