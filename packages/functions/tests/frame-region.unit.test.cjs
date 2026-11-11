/**
 * Frame regions (`src/lib/frame-region.ts`): the client's guide outline, the default outlines,
 * model-reported boxes, whether a read name lies on the held bottle, and the crop the glass
 * color is measured on.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const {
  DEFAULT_GUIDE_REGIONS,
  GUIDE_REGION_MIN_SIDE,
  NAME_BOX_BOTTLE_MARGIN,
  NAME_BOX_GUIDE_MARGIN,
  parseGuideRegion,
  guideRegionFor,
  parseNormalizedBox,
  nameLocation,
  cropToRegion,
} = require("../dist/lib/frame-region");

describe("lib/frame-region — constants", () => {
  it("mirrors the web client's outlines (AUTO_SHUTTER_REGIONS)", () => {
    assert.deepEqual(DEFAULT_GUIDE_REGIONS.glass, { x: 0.38, y: 0.38, w: 0.24, h: 0.24 });
    assert.deepEqual(DEFAULT_GUIDE_REGIONS.bottom, { x: 0.28, y: 0.25, w: 0.44, h: 0.5 });
    assert.deepEqual(DEFAULT_GUIDE_REGIONS.front, { x: 0.3, y: 0.15, w: 0.4, h: 0.7 });
    assert.deepEqual(DEFAULT_GUIDE_REGIONS.box, { x: 0.22, y: 0.2, w: 0.56, h: 0.6 });
    assert.equal(GUIDE_REGION_MIN_SIDE, 0.05);
    assert.equal(NAME_BOX_BOTTLE_MARGIN, 0.05);
    assert.equal(NAME_BOX_GUIDE_MARGIN, 0.1);
  });
});

describe("lib/frame-region — parseGuideRegion", () => {
  it("accepts a region inside the frame", () => {
    assert.deepEqual(parseGuideRegion({ x: 0.2, y: 0.3, w: 0.5, h: 0.4 }), { x: 0.2, y: 0.3, w: 0.5, h: 0.4 });
    assert.deepEqual(parseGuideRegion({ x: "0.2", y: "0.3", w: "0.5", h: "0.4" }), { x: 0.2, y: 0.3, w: 0.5, h: 0.4 });
  });
  it("rejects anything else", () => {
    for (const bad of [null, undefined, [], "x", { x: 0.1, y: 0.1, w: 0.5 }, { x: -0.1, y: 0, w: 0.5, h: 0.5 },
      { x: 0.6, y: 0, w: 0.5, h: 0.5 }, { x: 0, y: 0, w: 0.01, h: 0.5 }, { x: 0, y: 0, w: 120, h: 300 }, { x: NaN, y: 0, w: 0.5, h: 0.5 }]) {
      assert.equal(parseGuideRegion(bad), null, JSON.stringify(bad));
    }
  });
  it("guideRegionFor falls back to the surface's default outline", () => {
    assert.deepEqual(guideRegionFor("glass", {}), DEFAULT_GUIDE_REGIONS.glass);
    assert.deepEqual(guideRegionFor("glass", null), DEFAULT_GUIDE_REGIONS.glass);
    assert.deepEqual(guideRegionFor("glass", { guideRegion: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 } }), { x: 0.1, y: 0.1, w: 0.3, h: 0.3 });
    assert.deepEqual(guideRegionFor("glass", { guideRegion: { x: 2 } }), DEFAULT_GUIDE_REGIONS.glass);
  });
});

describe("lib/frame-region — parseNormalizedBox", () => {
  it("takes [left, top, right, bottom] in 0–1", () => {
    assert.deepEqual(parseNormalizedBox([0.1, 0.2, 0.3, 0.4]), [0.1, 0.2, 0.3, 0.4]);
  });
  it("rejects pixels, inverted or empty boxes and other shapes", () => {
    for (const bad of [[10, 20, 30, 40], [0.3, 0.2, 0.1, 0.4], [0.1, 0.2, 0.1, 0.4], [0.1, 0.2, 0.3], { left: 0 }, null, "0.1,0.2,0.3,0.4"]) {
      assert.equal(parseNormalizedBox(bad), null, JSON.stringify(bad));
    }
  });
});

describe("lib/frame-region — nameLocation", () => {
  // Sample 144: the held bottle low in the frame, "morgana" on a bottle standing behind it.
  const held = [0.13, 0.44, 0.87, 0.86];
  const background = [0.46, 0.35, 0.62, 0.4];
  it("a name whose centre is outside the held bottle is off the bottle", () => {
    assert.equal(nameLocation({ bottleBox: held, nameBox: background }), "off_bottle");
  });
  it("a name on the bottle (or within the margin of its edge) is on it", () => {
    assert.equal(nameLocation({ bottleBox: held, nameBox: [0.3, 0.5, 0.6, 0.6] }), "on_bottle");
    assert.equal(nameLocation({ bottleBox: held, nameBox: [0.4, 0.38, 0.6, 0.42] }), "on_bottle", "centre 0.04 above the box");
  });
  it("without a name box nothing is known; without a bottle box only the outline can reject", () => {
    assert.equal(nameLocation({ bottleBox: held, nameBox: null }), "unknown");
    assert.equal(nameLocation({ bottleBox: null, nameBox: background }), "unknown");
    const guide = { x: 0.28, y: 0.25, w: 0.44, h: 0.5 };
    assert.equal(nameLocation({ bottleBox: null, nameBox: [0.0, 0.0, 0.1, 0.05], guideRegion: guide }), "off_guide");
    assert.equal(nameLocation({ bottleBox: held, nameBox: [0.3, 0.5, 0.6, 0.6], guideRegion: guide }), "on_bottle");
  });
});

describe("lib/frame-region — cropToRegion", () => {
  it("crops to the region of the frame", async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="200">' +
      '<rect width="100" height="200" fill="#00FF00"/><rect x="40" y="80" width="20" height="40" fill="#FF0000"/></svg>';
    const image = await sharp(Buffer.from(svg)).png().toBuffer();
    const crop = await cropToRegion(image, { x: 0.4, y: 0.4, w: 0.2, h: 0.2 });
    const { data, info } = await sharp(crop).raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.width, 20);
    assert.equal(info.height, 40);
    assert.ok(data[0] > 200 && data[1] < 50, "red inside the region");
  });
  it("a region a few pixels wide leaves the frame as it is", async () => {
    const image = await sharp({ create: { width: 20, height: 20, channels: 3, background: "#123456" } }).png().toBuffer();
    assert.equal(await cropToRegion(image, { x: 0.5, y: 0.5, w: 0.1, h: 0.1 }), image);
  });
  it("rejects bytes that are not an image", async () => {
    await assert.rejects(cropToRegion(Buffer.from("nope"), { x: 0, y: 0, w: 1, h: 1 }));
  });
});
