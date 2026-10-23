const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");

const { colorDistance, hexToOklab, oklabToHex, rgbToHexString, oklabToRgb } = require("swatchwatch-shared");
const {
  clampBox,
  boxToPixels,
  parseNormalizedBox,
  isSparkleFinish,
  measureRegionColor,
  measureRegionsColor,
  gridCellToBox,
  gridCellLabel,
  drawLabeledGrid,
} = require("../dist/lib/region-color");
const {
  buildRegionLocatorPayload,
  parseRegionLocatorContent,
  regionCropStrategy,
} = require("../dist/eval/hex/strategies/region-crop");
const { STRATEGIES, getStrategy, strategySkipReason } = require("../dist/eval/hex/strategies");

// Build a PNG from a per-pixel RGB(A) callback.
function pngFrom(width, height, fill) {
  const buf = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a = 255] = fill(x, y);
      const i = (y * width + x) * 4;
      buf[i] = r;
      buf[i + 1] = g;
      buf[i + 2] = b;
      buf[i + 3] = a;
    }
  }
  return sharp(buf, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

const FULL = { x: 0, y: 0, w: 1, h: 1 };

describe("swatchwatch-shared OKLAB → hex", () => {
  it("round-trips hex → OKLAB → hex exactly for sRGB colors", () => {
    for (const hex of ["#000000", "#FFFFFF", "#670128", "#B2A6C5", "#22BACC", "#808080", "#FF00FF"]) {
      assert.equal(oklabToHex(hexToOklab(hex)), hex);
    }
  });

  it("clips out-of-gamut OKLAB values per channel", () => {
    const rgb = oklabToRgb({ L: 0.9, a: 0.4, b: 0 });
    assert.ok([rgb.r, rgb.g, rgb.b].every((c) => c >= 0 && c <= 255));
    assert.equal(rgbToHexString({ r: 300, g: -5, b: 12.4 }), "#FF000C");
  });
});

describe("lib/region-color — box handling", () => {
  it("passes a valid in-bounds box through unchanged", () => {
    assert.deepEqual(clampBox({ x: 0.2, y: 0.3, w: 0.4, h: 0.5 }), { x: 0.2, y: 0.3, w: 0.4, h: 0.5 });
  });

  it("clamps a box that spills outside the unit square", () => {
    const clamped = clampBox({ x: -0.2, y: 0.8, w: 0.5, h: 0.5 });
    assert.ok(clamped);
    assert.ok(Math.abs(clamped.x - 0) < 1e-9);
    assert.ok(Math.abs(clamped.w - 0.3) < 1e-9);
    assert.ok(Math.abs(clamped.y - 0.8) < 1e-9);
    assert.ok(Math.abs(clamped.h - 0.2) < 1e-9);
  });

  it("rejects boxes that are empty, non-finite, or entirely outside the image", () => {
    assert.equal(clampBox(null), null);
    assert.equal(clampBox({ x: 0.1, y: 0.1, w: 0, h: 0.2 }), null);
    assert.equal(clampBox({ x: 0.1, y: 0.1, w: 0.2, h: -0.1 }), null);
    assert.equal(clampBox({ x: NaN, y: 0.1, w: 0.2, h: 0.2 }), null);
    assert.equal(clampBox({ x: 0.1, y: Infinity, w: 0.2, h: 0.2 }), null);
    assert.equal(clampBox({ x: 1.2, y: 0.1, w: 0.2, h: 0.2 }), null, "x beyond the right edge");
    assert.equal(clampBox({ x: 0.1, y: 0.1, w: 0.001, h: 0.2 }), null, "thinner than the minimum side");
    assert.equal(clampBox({ x: 50, y: 50, w: 20, h: 20 }), null, "percent-style coordinates are not rescaled");
  });

  it("converts normalized boxes to at-least-1px integer crops inside the image", () => {
    assert.deepEqual(boxToPixels(FULL, 100, 50), { left: 0, top: 0, width: 100, height: 50 });
    assert.deepEqual(boxToPixels({ x: 0.25, y: 0.5, w: 0.5, h: 0.25 }, 100, 80), { left: 25, top: 40, width: 50, height: 20 });
    const tiny = boxToPixels({ x: 0.999, y: 0.999, w: 0.001, h: 0.001 }, 10, 10);
    assert.deepEqual(tiny, { left: 9, top: 9, width: 1, height: 1 });
  });

  it("parses model box JSON with numbers, numeric strings, width/height aliases and corners", () => {
    assert.deepEqual(parseNormalizedBox({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }), { x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
    assert.deepEqual(parseNormalizedBox({ x: "0.1", y: "0.2", width: "0.3", height: "0.4" }), { x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
    const fromCorners = parseNormalizedBox({ x: 0.1, y: 0.2, x2: 0.5, y2: 0.9 });
    assert.ok(Math.abs(fromCorners.w - 0.4) < 1e-9 && Math.abs(fromCorners.h - 0.7) < 1e-9);
    assert.equal(parseNormalizedBox({ x: 0.1, y: 0.2 }), null);
    assert.equal(parseNormalizedBox({ x: "abc", y: 0.2, w: 0.1, h: 0.1 }), null);
    assert.equal(parseNormalizedBox(null), null);
    assert.equal(parseNormalizedBox("0.1,0.2"), null);
  });
});

describe("lib/region-color — isSparkleFinish", () => {
  it("flags glitter/holo/flake/shimmer and ignores plain finishes", () => {
    assert.equal(isSparkleFinish(["creme"]), false);
    assert.equal(isSparkleFinish(["matte", "metallic"]), false);
    assert.equal(isSparkleFinish(["glitter"]), true);
    assert.equal(isSparkleFinish(["Holographic"]), true);
    assert.equal(isSparkleFinish(["creme", "flake"]), true);
    assert.equal(isSparkleFinish(["shimmer"]), true);
    assert.equal(isSparkleFinish([]), false);
    assert.equal(isSparkleFinish(null), false);
    assert.equal(isSparkleFinish([42, "creme"]), false);
  });
});

describe("lib/region-color — measureRegionColor", () => {
  it("returns the exact color of a flat crop", async () => {
    const png = await pngFrom(40, 40, () => [0x67, 0x01, 0x28]);
    const result = await measureRegionColor(png, FULL);
    assert.equal(result.hex, "#670128");
    assert.equal(result.pixels.sampled, 1600);
    assert.equal(result.pixels.highlightsDropped, 80, "5% of 1600");
    assert.equal(result.pixels.measured, 1520);
    assert.equal(result.darkFloorApplied, false);
    assert.equal(result.usedDarkerHalf, false);
    assert.deepEqual(result.box, { left: 0, top: 0, width: 40, height: 40 });
    assert.equal(result.imageWidth, 40);
    assert.equal(result.imageHeight, 40);
  });

  it("only measures the pixels inside the box", async () => {
    // Left half red, right half blue; the box covers the right half only.
    const png = await pngFrom(40, 20, (x) => (x < 20 ? [255, 0, 0] : [0, 0, 255]));
    const result = await measureRegionColor(png, { x: 0.5, y: 0, w: 0.5, h: 1 });
    assert.equal(result.hex, "#0000FF");
    assert.deepEqual(result.box, { left: 20, top: 0, width: 20, height: 20 });
  });

  it("drops a small white specular patch so the median stays on the base color", async () => {
    // 4% of pixels are a white highlight in the corner.
    const png = await pngFrom(50, 50, (x, y) => (x < 10 && y < 10 ? [255, 255, 255] : [0x22, 0xba, 0xcc]));
    const result = await measureRegionColor(png, FULL);
    assert.equal(result.hex, "#22BACC");
    assert.equal(result.pixels.highlightsDropped, 125);
    assert.ok(result.highlightCutoffL !== null && result.highlightCutoffL < 0.9, `cutoff ${result.highlightCutoffL}`);
    // A plain (non-highlight-aware) mean would have been lifted toward white.
    const naive = oklabToHex({
      L: hexToOklab("#22BACC").L * 0.96 + hexToOklab("#FFFFFF").L * 0.04,
      a: hexToOklab("#22BACC").a * 0.96,
      b: hexToOklab("#22BACC").b * 0.96,
    });
    assert.ok(colorDistance(naive, "#22BACC") > colorDistance(result.hex, "#22BACC"));
  });

  it("reports the highlight cutoff when highlights are dropped and null when nothing is", async () => {
    const png = await pngFrom(20, 20, () => [100, 100, 100]);
    const dropped = await measureRegionColor(png, FULL);
    assert.ok(dropped.highlightCutoffL !== null);
    const kept = await measureRegionColor(png, FULL, { highlightFraction: 0 });
    assert.equal(kept.highlightCutoffL, null);
    assert.equal(kept.pixels.highlightsDropped, 0);
    assert.equal(kept.pixels.measured, 400);
  });

  it("drops very dark edge pixels when they are a minority", async () => {
    // A 2px near-black border (19% of pixels) around a mid-tone fill.
    const png = await pngFrom(40, 40, (x, y) =>
      x < 2 || y < 2 || x >= 38 || y >= 38 ? [5, 5, 5] : [0xb2, 0xa6, 0xc5]
    );
    const result = await measureRegionColor(png, FULL);
    assert.equal(result.hex, "#B2A6C5");
    assert.equal(result.darkFloorApplied, true);
    assert.ok(result.pixels.darkDropped > 0);
    assert.ok(result.pixels.darkDropped <= 304, `border is 304px, dropped ${result.pixels.darkDropped}`);
  });

  it("does not drop dark pixels when they are more than a quarter of the crop", async () => {
    // 40% of the crop is a deep shadow: this is a dark polish with a gradient, not an edge.
    const png = await pngFrom(50, 50, (x) => (x < 20 ? [6, 6, 6] : [0x67, 0x01, 0x28]));
    const result = await measureRegionColor(png, FULL, { highlightFraction: 0 });
    assert.equal(result.darkFloorApplied, false);
    assert.equal(result.pixels.darkDropped, 0);
    assert.equal(result.hex, "#670128", "the median still lands on the majority color");
  });

  it("keeps the dark floor off for a genuinely dark (black) polish", async () => {
    // Every pixel is below the floor, so dark pixels are not a minority: nothing is dropped.
    const png = await pngFrom(30, 30, () => [8, 8, 10]);
    const result = await measureRegionColor(png, FULL);
    assert.equal(result.darkFloorApplied, false);
    assert.equal(result.pixels.darkDropped, 0);
    assert.equal(result.hex, "#08080A");
  });

  it("uses the darker half for sparkle finishes so bright particles do not lift the base", async () => {
    // 45% bright "sparkle" pixels scattered over a deep base. A plain median over all
    // pixels still lands on the base, but a 55/45 split is close enough that the
    // darker-half median must land squarely on the base while the full median of a
    // 50/50 image would not.
    const base = [0x3a, 0x10, 0x5c];
    const sparkle = [0xe8, 0xd8, 0xf5];
    const png = await pngFrom(40, 40, (x, y) => ((x + y) % 2 === 0 ? sparkle : base));
    const plain = await measureRegionColor(png, FULL, { highlightFraction: 0 });
    const darker = await measureRegionColor(png, FULL, { highlightFraction: 0, darkerHalf: true });
    assert.equal(darker.usedDarkerHalf, true);
    assert.equal(darker.hex, "#3A105C");
    assert.ok(
      colorDistance(plain.hex, "#3A105C") > colorDistance(darker.hex, "#3A105C"),
      `plain ${plain.hex} should be lifted vs darker-half ${darker.hex}`
    );
    assert.equal(darker.pixels.measured, Math.ceil(plain.pixels.measured / 2));
  });

  it("throws on an invalid box and on a fully transparent crop", async () => {
    const png = await pngFrom(20, 20, () => [10, 20, 30]);
    await assert.rejects(() => measureRegionColor(png, { x: 0.5, y: 0.5, w: 0, h: 0.2 }), /Invalid region box/);
    await assert.rejects(() => measureRegionColor(png, { x: 2, y: 2, w: 0.5, h: 0.5 }), /Invalid region box/);
    const transparent = await pngFrom(20, 20, () => [10, 20, 30, 0]);
    await assert.rejects(() => measureRegionColor(transparent, FULL), /no opaque pixels/);
  });

  it("clamps an overflowing box to the image before cropping", async () => {
    const png = await pngFrom(40, 40, (x) => (x < 20 ? [255, 0, 0] : [0, 255, 0]));
    const result = await measureRegionColor(png, { x: 0.5, y: -0.5, w: 2, h: 3 });
    assert.equal(result.hex, "#00FF00");
    assert.deepEqual(result.box, { left: 20, top: 0, width: 20, height: 40 });
  });
});

describe("lib/region-color — grid cells and multi-box measurement", () => {
  it("maps cell labels to inset normalized boxes and rejects labels outside the grid", () => {
    assert.equal(gridCellLabel(0, 0), "A1");
    assert.equal(gridCellLabel(5, 5), "F6");
    const a1 = gridCellToBox("A1", 4, 1);
    assert.deepEqual(a1, { x: 0, y: 0, w: 0.25, h: 0.25 });
    const c2 = gridCellToBox(" c2 ", 4, 0.5);
    assert.ok(Math.abs(c2.x - (0.25 + 0.0625)) < 1e-9 && Math.abs(c2.y - (0.5 + 0.0625)) < 1e-9);
    assert.ok(Math.abs(c2.w - 0.125) < 1e-9 && Math.abs(c2.h - 0.125) < 1e-9);
    assert.equal(gridCellToBox("E1", 4), null, "row out of range");
    assert.equal(gridCellToBox("A5", 4), null, "column out of range");
    assert.equal(gridCellToBox("A0", 4), null);
    assert.equal(gridCellToBox("1A", 4), null);
    assert.equal(gridCellToBox(3, 4), null);
  });

  it("pools pixels across boxes and skips invalid ones", async () => {
    // Quadrants: TL red, TR blue, BL blue, BR green. Two blue boxes plus one invalid box.
    const png = await pngFrom(40, 40, (x, y) => (x < 20 && y < 20 ? [255, 0, 0] : x >= 20 && y >= 20 ? [0, 255, 0] : [0, 0, 255]));
    const result = await measureRegionsColor(png, [
      { x: 0.5, y: 0, w: 0.5, h: 0.5 },
      { x: 0, y: 0.5, w: 0.5, h: 0.5 },
      { x: 3, y: 3, w: 0.1, h: 0.1 },
    ]);
    assert.equal(result.hex, "#0000FF");
    assert.equal(result.boxes.length, 2);
    assert.deepEqual(result.box, { left: 0, top: 0, width: 40, height: 40 }, "bounding box of all crops");
    await assert.rejects(() => measureRegionsColor(png, [{ x: 2, y: 2, w: 1, h: 1 }]), /Invalid region box/);
    await assert.rejects(() => measureRegionsColor(png, []), /Invalid region box/);
  });
});

describe("lib/region-color — drawLabeledGrid", () => {
  it("returns a JPEG of the same aspect ratio with grid pixels painted", async () => {
    const png = await pngFrom(80, 40, () => [0x33, 0x66, 0x99]);
    const out = await drawLabeledGrid(png, { cells: 4 });
    const meta = await sharp(out).metadata();
    assert.equal(meta.format, "jpeg");
    assert.equal(meta.width, 80);
    assert.equal(meta.height, 40);
    const palette = await measureRegionColor(out, FULL, { highlightFraction: 0, darkFloorL: 0 });
    // Still mostly the base color, but no longer exactly it (lines/labels were drawn).
    assert.ok(colorDistance(palette.hex, "#336699") < 0.1);
    const { data } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    let changed = 0;
    for (let i = 0; i < data.length; i += 3) {
      if (Math.abs(data[i] - 0x33) + Math.abs(data[i + 1] - 0x66) + Math.abs(data[i + 2] - 0x99) > 60) changed += 1;
    }
    assert.ok(changed > 40, `expected grid pixels to differ from the base, got ${changed}`);
  });
});

describe("eval/hex region-crop strategy — pure parts", () => {
  it("is registered and requires Azure OpenAI", () => {
    assert.ok(STRATEGIES.includes(regionCropStrategy));
    assert.equal(getStrategy("region-crop"), regionCropStrategy);
    assert.equal(regionCropStrategy.requiresAzureOpenAI, true);
    assert.match(strategySkipReason(regionCropStrategy, false), /Azure OpenAI is not configured/);
    assert.equal(strategySkipReason(regionCropStrategy, true), null);
  });

  it("builds a JSON-mode bbox payload with the image and the requested detail", () => {
    const payload = buildRegionLocatorPayload("data:image/png;base64,AAAA", { mode: "bbox", gridCells: 0, detail: "low" });
    assert.equal(payload.temperature, 0);
    assert.deepEqual(payload.response_format, { type: "json_object" });
    assert.equal(payload.messages[0].role, "system");
    assert.match(payload.messages[0].content, /"region":"nail"\|"bottle"\|"swatch"\|"other"/);
    assert.match(payload.messages[0].content, /"x":0\.\.1/);
    const parts = payload.messages[1].content;
    assert.equal(parts[1].type, "image_url");
    assert.deepEqual(parts[1].image_url, { url: "data:image/png;base64,AAAA", detail: "low" });
    assert.doesNotMatch(parts[0].text, /grid/i);

    const gridded = buildRegionLocatorPayload("data:image/jpeg;base64,BBBB", { mode: "bbox", gridCells: 4, detail: "high" });
    assert.match(gridded.messages[1].content[0].text, /4x4 grid/);
    assert.equal(gridded.messages[1].content[1].image_url.detail, "high");

    const safe = buildRegionLocatorPayload("data:image/png;base64,AAAA", { mode: "bbox", gridCells: 0, detail: "low", safePrompt: true });
    assert.notEqual(safe.messages[0].content, payload.messages[0].content);
    assert.match(safe.messages[0].content, /valid JSON only/);
  });

  it("builds a cells payload that names the grid and asks for cell labels", () => {
    const payload = buildRegionLocatorPayload("data:image/jpeg;base64,CCCC", { mode: "cells", gridCells: 6, detail: "low" });
    assert.match(payload.messages[0].content, /6x6 grid/);
    assert.match(payload.messages[0].content, /F6 bottom-right/);
    assert.match(payload.messages[0].content, /"cells":\["C3"/);
    assert.doesNotMatch(payload.messages[0].content, /"x":0\.\.1/);
    const safe = buildRegionLocatorPayload("data:image/jpeg;base64,CCCC", { mode: "cells", gridCells: 6, detail: "low", safePrompt: true });
    assert.match(safe.messages[0].content, /valid JSON only/);
    assert.notEqual(safe.messages[0].content, payload.messages[0].content);
  });

  it("parses a well-formed bbox reply", () => {
    const result = parseRegionLocatorContent(
      JSON.stringify({ x: 0.3, y: 0.4, w: 0.2, h: 0.25, region: "Bottle", finishes: ["creme", "Shimmer", 7], confidence: "0.8" }),
      { mode: "bbox" }
    );
    assert.deepEqual(result.boxes, [{ x: 0.3, y: 0.4, w: 0.2, h: 0.25 }]);
    assert.equal(result.region, "bottle");
    assert.deepEqual(result.rawFinishes, ["creme", "Shimmer"]);
    assert.equal(result.confidence, 0.8);
  });

  it("accepts a nested box object and clamps spill-over", () => {
    const result = parseRegionLocatorContent(JSON.stringify({ box: { x: 0.9, y: 0.1, w: 0.5, h: 0.2 }, region: "nail" }));
    assert.ok(result.rawBox);
    assert.ok(Math.abs(result.boxes[0].w - 0.1) < 1e-9);
    assert.equal(result.region, "nail");
    assert.deepEqual(result.rawFinishes, []);
    assert.equal(result.confidence, null);
  });

  it("parses a cells reply, dropping invalid and duplicate labels and capping the count", () => {
    const cells = ["b2", "B2", "Z9", "C 3", 4, "A1", "A2", "A3", "A4", "A5", "A6", "B1", "B3"];
    const result = parseRegionLocatorContent(JSON.stringify({ cells, region: "nail", finishes: ["glitter"], confidence: 0.6 }), {
      mode: "cells",
      gridCells: 6,
    });
    assert.deepEqual(result.rawCells.slice(0, 4), ["B2", "Z9", "C3", "A1"]);
    assert.equal(result.boxes.length, 8, "capped at MAX_CELLS");
    assert.deepEqual(result.boxes[0], gridCellToBox("B2", 6));
    assert.equal(result.rawBox, null);
    assert.deepEqual(result.rawFinishes, ["glitter"]);
  });

  it("yields no boxes for invalid, missing or unparseable replies without throwing", () => {
    assert.deepEqual(parseRegionLocatorContent(null).boxes, []);
    assert.deepEqual(parseRegionLocatorContent("not json").boxes, []);
    assert.deepEqual(parseRegionLocatorContent("[1,2]").boxes, []);
    const empty = parseRegionLocatorContent(JSON.stringify({ x: 0.1, y: 0.1, w: 0, h: 0.2, region: "rooftop" }));
    assert.deepEqual(empty.rawBox, { x: 0.1, y: 0.1, w: 0, h: 0.2 });
    assert.deepEqual(empty.boxes, []);
    assert.equal(empty.region, null);
    assert.deepEqual(parseRegionLocatorContent(JSON.stringify({ cells: "B2" }), { mode: "cells", gridCells: 6 }).boxes, []);
  });
});

describe("eval/hex region-crop strategy — run", () => {
  const saved = {};
  const KEYS = [
    "AZURE_OPENAI_ENDPOINT",
    "AZURE_OPENAI_KEY",
    "AZURE_OPENAI_DEPLOYMENT_HEX",
    "AZURE_OPENAI_DEPLOYMENT",
    "HEX_EVAL_REGION_CROP_GRID",
    "HEX_EVAL_REGION_CROP_MODE",
    "HEX_EVAL_REGION_CROP_CELLS",
    "HEX_EVAL_REGION_CROP_DETAIL",
  ];
  let originalFetch;

  beforeEach(() => {
    for (const key of KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    originalFetch = global.fetch;
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    global.fetch = originalFetch;
  });

  async function input(png) {
    return {
      evalCase: {
        id: "t:1",
        brand: "T",
        shadeName: "One",
        finishes: ["creme"],
        groundTruthHex: "#000000",
        groundTruthSource: "manual",
        source: "Test",
        imageUrl: "https://example.com/a.png",
      },
      image: { bytes: png, contentType: "image/png", dataUri: `data:image/png;base64,${png.toString("base64")}`, sourceUrl: null },
    };
  }

  it("throws a clear error when Azure OpenAI is not configured (runner skips it before this)", async () => {
    const png = await pngFrom(10, 10, () => [1, 2, 3]);
    const strategyInput = await input(png);
    await assert.rejects(() => regionCropStrategy.run(strategyInput), /Azure OpenAI config missing/);
  });

  it("measures the model's box from the original pixels and fills meta", async () => {
    process.env.AZURE_OPENAI_ENDPOINT = "https://example.openai.azure.com";
    process.env.AZURE_OPENAI_KEY = "k";
    process.env.AZURE_OPENAI_DEPLOYMENT_HEX = "d";
    process.env.HEX_EVAL_REGION_CROP_MODE = "bbox";
    // Left half red (the "cap"), right half the polish; the model boxes the right half.
    const png = await pngFrom(40, 40, (x) => (x < 20 ? [255, 0, 0] : [0x67, 0x01, 0x28]));
    let requestBody = null;
    global.fetch = async (_url, init) => {
      requestBody = JSON.parse(init.body);
      const content = JSON.stringify({ x: 0.55, y: 0.05, w: 0.4, h: 0.9, region: "bottle", finishes: ["creme"], confidence: 0.9 });
      return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const output = await regionCropStrategy.run(await input(png));
    assert.equal(output.hex, "#670128");
    assert.equal(output.confidence, 0.9);
    assert.deepEqual(output.finishes, ["creme"]);
    assert.equal(output.meta.region, "bottle");
    assert.equal(output.meta.gridCells, 0);
    assert.deepEqual(output.meta.box, { x: 0.55, y: 0.05, w: 0.4, h: 0.9 });
    assert.deepEqual(output.meta.pixelBox, { left: 22, top: 2, width: 16, height: 36 });
    assert.equal(output.meta.usedDarkerHalf, false);
    assert.equal(typeof output.meta.pixels.measured, "number");
    assert.equal(output.meta.usage.totalTokens, 15);
    assert.equal(requestBody.response_format.type, "json_object");
    assert.equal(requestBody.messages[1].content[1].image_url.url, (await input(png)).image.dataUri);
  });

  it("uses the darker-half measurement when the model reports a sparkle finish", async () => {
    process.env.AZURE_OPENAI_ENDPOINT = "https://example.openai.azure.com";
    process.env.AZURE_OPENAI_KEY = "k";
    process.env.AZURE_OPENAI_DEPLOYMENT_HEX = "d";
    process.env.HEX_EVAL_REGION_CROP_MODE = "bbox";
    const png = await pngFrom(40, 40, (x, y) => ((x + y) % 2 === 0 ? [0xe8, 0xd8, 0xf5] : [0x3a, 0x10, 0x5c]));
    global.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ x: 0, y: 0, w: 1, h: 1, region: "nail", finishes: ["holographic", "glitter"], confidence: 0.7 }) } }],
        }),
        { status: 200 }
      );
    const output = await regionCropStrategy.run(await input(png));
    assert.equal(output.meta.usedDarkerHalf, true);
    assert.equal(output.hex, "#3A105C");
    assert.deepEqual(output.finishes, ["holographic", "glitter"]);
  });

  it("returns a null hex with the reason when the model's box is unusable", async () => {
    process.env.AZURE_OPENAI_ENDPOINT = "https://example.openai.azure.com";
    process.env.AZURE_OPENAI_KEY = "k";
    process.env.AZURE_OPENAI_DEPLOYMENT_HEX = "d";
    process.env.HEX_EVAL_REGION_CROP_MODE = "bbox";
    const png = await pngFrom(10, 10, () => [1, 2, 3]);
    global.fetch = async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ x: 1.5, y: 0.2, w: 0.3, h: 0.3, region: "other" }) } }] }), { status: 200 });
    const output = await regionCropStrategy.run(await input(png));
    assert.equal(output.hex, null);
    assert.equal(output.meta.box, null);
    assert.equal(output.meta.reason, "invalid_box");
    assert.equal(output.meta.mode, "bbox");
    assert.deepEqual(output.meta.rawBox, { x: 1.5, y: 0.2, w: 0.3, h: 0.3 });
  });

  it("sends the gridded copy to the model but measures the original when the grid flag is on", async () => {
    process.env.AZURE_OPENAI_ENDPOINT = "https://example.openai.azure.com";
    process.env.AZURE_OPENAI_KEY = "k";
    process.env.AZURE_OPENAI_DEPLOYMENT_HEX = "d";
    process.env.HEX_EVAL_REGION_CROP_MODE = "bbox";
    process.env.HEX_EVAL_REGION_CROP_GRID = "true";
    const png = await pngFrom(64, 64, () => [0x22, 0xba, 0xcc]);
    let sentUrl = null;
    global.fetch = async (_url, init) => {
      sentUrl = JSON.parse(init.body).messages[1].content[1].image_url.url;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ x: 0.1, y: 0.1, w: 0.8, h: 0.8, region: "swatch" }) } }] }), { status: 200 });
    };
    const output = await regionCropStrategy.run(await input(png));
    assert.ok(sentUrl.startsWith("data:image/jpeg;base64,"));
    assert.notEqual(sentUrl, (await input(png)).image.dataUri);
    assert.equal(output.meta.gridCells, 4);
    assert.equal(output.hex, "#22BACC", "measured from the original, not the gridded copy");
  });

  it("cells mode (default): sends a gridded copy, measures the named cells from the original pixels", async () => {
    process.env.AZURE_OPENAI_ENDPOINT = "https://example.openai.azure.com";
    process.env.AZURE_OPENAI_KEY = "k";
    process.env.AZURE_OPENAI_DEPLOYMENT_HEX = "d";
    // Left third of a 60x60 image is skin-ish, the rest the polish. 6x6 grid → 10px cells.
    const png = await pngFrom(60, 60, (x) => (x < 20 ? [0x8a, 0x5a, 0x44] : [0xb2, 0xa6, 0xc5]));
    let sent = null;
    global.fetch = async (_url, init) => {
      sent = JSON.parse(init.body);
      const content = JSON.stringify({ cells: ["C3", "C4", "D5", "Q9"], region: "nail", finishes: ["creme"], confidence: 0.85 });
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    };
    const strategyInput = await input(png);
    const output = await regionCropStrategy.run(strategyInput);
    assert.match(sent.messages[0].content, /6x6 grid/);
    assert.ok(sent.messages[1].content[1].image_url.url.startsWith("data:image/jpeg;base64,"));
    assert.equal(output.meta.mode, "cells");
    assert.equal(output.meta.gridCells, 6);
    assert.deepEqual(output.meta.cells, ["C3", "C4", "D5", "Q9"]);
    assert.equal(output.meta.boxes.length, 3, "Q9 is outside the grid");
    assert.equal(output.meta.pixelBoxes.length, 3);
    assert.equal(output.hex, "#B2A6C5");
  });

  it("cells mode: returns a null hex when no named cell is on the grid", async () => {
    process.env.AZURE_OPENAI_ENDPOINT = "https://example.openai.azure.com";
    process.env.AZURE_OPENAI_KEY = "k";
    process.env.AZURE_OPENAI_DEPLOYMENT_HEX = "d";
    const png = await pngFrom(30, 30, () => [1, 2, 3]);
    global.fetch = async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ cells: [], region: "other" }) } }] }), { status: 200 });
    const output = await regionCropStrategy.run(await input(png));
    assert.equal(output.hex, null);
    assert.equal(output.meta.reason, "no_valid_cells");
  });
});
