/**
 * Palette-pick hex detection (`src/lib/palette-pick-detection.ts`): the pure
 * pieces — candidate generation/dedupe, composite layout math, prompt payload,
 * response parsing and letter→hex mapping — plus the end-to-end call against a
 * stubbed `fetch`. No network, no database.
 */
const { describe, it, before, after, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");
const sharp = require("sharp");

// ── Module mocks (db → finish catalog) ───────────────────────────────────────
const mockModules = {};
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  for (const key of Object.keys(mockModules)) {
    if (request === key || request.endsWith(key)) return key;
  }
  return originalResolve.call(this, request, parent, ...rest);
};
function registerMock(id, exports) {
  mockModules[id] = exports;
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
const dbMock = {
  query: async () => ({
    rows: [
      { kind: "type", sourceValue: "creme", normalizedFinishName: "creme" },
      { kind: "type", sourceValue: "shimmer", normalizedFinishName: "shimmer" },
      { kind: "type", sourceValue: "holographic", normalizedFinishName: "holographic" },
      { kind: "alias", sourceValue: "holo", normalizedFinishName: "holographic" },
    ],
    rowCount: 4,
  }),
  transaction: async (cb) => cb({ query: dbMock.query }),
  getPool: () => ({}),
  closePool: async () => {},
};
registerMock(path.resolve(__dirname, "../dist/lib/db.js"), dbMock);
registerMock("../lib/db", dbMock);

const { colorDistance } = require("swatchwatch-shared");
const {
  CHIP_LABELS,
  PALETTE_PICK_DEFAULTS,
  buildPaletteCandidates,
  extractPaletteCandidates,
  fitPhoto,
  computeCompositeLayout,
  labelColorFor,
  buildCompositeSvg,
  renderPaletteComposite,
  buildPalettePickPayload,
  normalizeChoiceLabel,
  parsePaletteChoice,
  detectHexByPalettePick,
} = require("../dist/lib/palette-pick-detection");
const { palettePickStrategy } = require("../dist/eval/hex/strategies/palette-pick");
const { STRATEGIES, getStrategy } = require("../dist/eval/hex/strategies");

const quiet = { onLog: () => undefined };

function candidates(hexes) {
  return hexes.map((hex, index) => ({ label: CHIP_LABELS[index], hex, fraction: 1 / hexes.length }));
}

/** A synthetic "product shot": white background, teal bottle, black cap, pink label. */
function syntheticBottle() {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400">' +
    '<rect width="300" height="400" fill="#FFFFFF"/>' +
    '<rect x="100" y="150" width="100" height="210" fill="#22BACC"/>' +
    '<rect x="120" y="75" width="60" height="80" fill="#111111"/>' +
    '<rect x="115" y="250" width="70" height="30" fill="#E8A0C8"/>' +
    "</svg>";
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function pixelAt(png, x, y) {
  const { data } = await sharp(png).extract({ left: x, top: y, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
  return `#${[data[0], data[1], data[2]].map((v) => v.toString(16).padStart(2, "0").toUpperCase()).join("")}`;
}

// ── Candidates ───────────────────────────────────────────────────────────────

describe("palette-pick — buildPaletteCandidates", () => {
  it("labels candidates A, B, C… in prominence order", () => {
    const out = buildPaletteCandidates([
      { hex: "#FF0000", fraction: 0.5 },
      { hex: "#00FF00", fraction: 0.3 },
      { hex: "#0000FF", fraction: 0.2 },
    ]);
    assert.deepEqual(
      out.map((c) => [c.label, c.hex]),
      [
        ["A", "#FF0000"],
        ["B", "#00FF00"],
        ["C", "#0000FF"],
      ]
    );
  });

  it("merges perceptually near-identical colors into one chip (summing their share)", () => {
    const out = buildPaletteCandidates([
      { hex: "#22BACC", fraction: 0.4 },
      { hex: "#23BBCD", fraction: 0.3 }, // a neighbouring quantization bucket
      { hex: "#111111", fraction: 0.3 },
    ]);
    assert.equal(out.length, 2);
    assert.equal(out[0].hex, "#22BACC");
    assert.equal(out[0].fraction, 0.7);
    assert.ok(colorDistance(out[0].hex, out[1].hex) > PALETTE_PICK_DEFAULTS.mergeDistances[0]);
  });

  it("never returns more than maxCandidates (default 12) and keeps the most prominent", () => {
    const raw = Array.from({ length: 30 }, (_, i) => ({
      hex: `#${(i * 8).toString(16).padStart(2, "0")}${((i * 37) % 256).toString(16).padStart(2, "0")}${((255 - i * 8) >>> 0).toString(16).padStart(2, "0")}`.toUpperCase(),
      fraction: (30 - i) / 465,
    }));
    const out = buildPaletteCandidates(raw);
    assert.ok(out.length <= 12, `got ${out.length}`);
    assert.equal(out[0].label, "A");
    assert.equal(out[out.length - 1].label, CHIP_LABELS[out.length - 1]);
    for (let i = 1; i < out.length; i += 1) {
      assert.ok(out[i - 1].fraction >= out[i].fraction, "ordered by prominence");
    }
    const capped = buildPaletteCandidates(raw, { maxCandidates: 5, minCandidates: 3 });
    assert.equal(capped.length, 5);
  });

  it("tightens the merge distance when the loose pass leaves fewer than minCandidates", () => {
    // Six colors in three tight pairs: at 0.04 they collapse to 3, at 0.015 they stay 6.
    const raw = [
      ["#22BACC", "#2BC0D1"],
      ["#E8A0C8", "#EDA7CE"],
      ["#404040", "#474747"],
    ].flatMap(([a, b]) => [
      { hex: a, fraction: 0.2 },
      { hex: b, fraction: 0.13 },
    ]);
    const loose = buildPaletteCandidates(raw, { minCandidates: 1 });
    assert.equal(loose.length, 3);
    const tightened = buildPaletteCandidates(raw, { minCandidates: 6 });
    assert.equal(tightened.length, 6);
    // Unreachable minimums just return the tightest pass.
    const best = buildPaletteCandidates(raw, { minCandidates: 12 });
    assert.equal(best.length, 6);
  });

  it("drops noise below minFraction and returns [] for no input", () => {
    const out = buildPaletteCandidates([
      { hex: "#FFFFFF", fraction: 0.999 },
      { hex: "#FF0000", fraction: 0.001 },
    ]);
    assert.deepEqual(
      out.map((c) => c.hex),
      ["#FFFFFF"]
    );
    assert.deepEqual(buildPaletteCandidates([]), []);
  });

  it("extractPaletteCandidates finds the bottle color in a synthetic product shot as a distinct chip", async () => {
    const out = await extractPaletteCandidates(await syntheticBottle());
    assert.ok(out.length >= 4 && out.length <= 12, `got ${out.length}`);
    assert.equal(out[0].hex, "#FFFFFF", "background is the most prominent");
    const teal = out.find((c) => colorDistance(c.hex, "#22BACC") < 0.02);
    assert.ok(teal, `expected a teal chip in ${out.map((c) => c.hex).join(",")}`);
    const labels = out.map((c) => c.label);
    assert.deepEqual(labels, CHIP_LABELS.slice(0, out.length).split(""));
  });
});

// ── Layout ───────────────────────────────────────────────────────────────────

describe("palette-pick — layout math", () => {
  it("fitPhoto scales the longest edge down and never enlarges", () => {
    assert.deepEqual(fitPhoto(1000, 500, 512), { width: 512, height: 256 });
    assert.deepEqual(fitPhoto(300, 400, 512), { width: 300, height: 400 });
    assert.deepEqual(fitPhoto(0, 0, 512), { width: 1, height: 1 });
  });

  it("places the photo at the padding and one chip per candidate in a strip to its right", () => {
    const layout = computeCompositeLayout({ photoWidth: 384, photoHeight: 512, candidates: candidates(["#111111", "#222222", "#333333"]) });
    assert.deepEqual(layout.photo, { x: 16, y: 16, width: 384, height: 512 });
    assert.equal(layout.chips.length, 3);
    assert.equal(layout.columns, 1);
    assert.equal(layout.rows, 3);
    assert.deepEqual(
      layout.chips.map((c) => [c.label, c.hex]),
      [
        ["A", "#111111"],
        ["B", "#222222"],
        ["C", "#333333"],
      ]
    );
    for (const chip of layout.chips) {
      assert.ok(chip.x >= layout.photo.x + layout.photo.width, "strip is right of the photo");
      assert.ok(chip.x + chip.width <= layout.width - 16 && chip.y + chip.height <= layout.height - 16, "inside the canvas");
    }
  });

  it("uses two columns, row-major, for more than six chips and sizes chips to fit the photo height", () => {
    const layout = computeCompositeLayout({ photoWidth: 512, photoHeight: 512, candidates: candidates(Array(12).fill("#ABCDEF")) });
    assert.equal(layout.columns, 2);
    assert.equal(layout.rows, 6);
    // 6 rows + 5 gaps fit inside 512: chip = floor((512 - 60) / 6) = 75
    assert.equal(layout.chipSize, 75);
    assert.equal(layout.chips[0].y, layout.chips[1].y, "A and B share a row");
    assert.equal(layout.chips[0].x + 75 + 12, layout.chips[1].x);
    assert.equal(layout.chips[2].y, layout.chips[0].y + 75 + 12, "C starts the next row");
    assert.equal(layout.height, 512 + 32, "strip fits in the photo height");
    assert.equal(layout.width, 16 + 512 + 24 + 75 * 2 + 12 + 16);
    // No two chips overlap.
    for (let i = 0; i < layout.chips.length; i += 1) {
      for (let j = i + 1; j < layout.chips.length; j += 1) {
        const a = layout.chips[i];
        const b = layout.chips[j];
        const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
        assert.equal(overlap, false, `${a.label} overlaps ${b.label}`);
      }
    }
  });

  it("clamps chips to the minimum size and grows the canvas for short photos", () => {
    const layout = computeCompositeLayout({ photoWidth: 512, photoHeight: 120, candidates: candidates(Array(12).fill("#ABCDEF")) });
    assert.equal(layout.chipSize, PALETTE_PICK_DEFAULTS.minChipSize);
    assert.equal(layout.height, 6 * 56 + 5 * 12 + 32);
    const tall = computeCompositeLayout({ photoWidth: 100, photoHeight: 2000, candidates: candidates(["#000000"]) });
    assert.equal(tall.chipSize, PALETTE_PICK_DEFAULTS.maxChipSize);
  });

  it("handles zero candidates without a strip", () => {
    const layout = computeCompositeLayout({ photoWidth: 200, photoHeight: 100, candidates: [] });
    assert.equal(layout.chips.length, 0);
    assert.equal(layout.height, 132);
  });

  it("picks a readable label color and emits every chip in the SVG", () => {
    assert.equal(labelColorFor("#FFFFFF"), "#000000");
    assert.equal(labelColorFor("#000000"), "#FFFFFF");
    assert.equal(labelColorFor("#22BACC"), "#000000");
    assert.equal(labelColorFor("#1A1A6E"), "#FFFFFF");
    const svg = buildCompositeSvg(computeCompositeLayout({ photoWidth: 100, photoHeight: 100, candidates: candidates(["#22BACC", "#111111"]) }));
    assert.match(svg, /fill="#22BACC"/);
    assert.match(svg, /fill="#111111"/);
    assert.match(svg, />A<\/text>/);
    assert.match(svg, />B<\/text>/);
  });

  it("renderPaletteComposite produces a PNG matching the layout with solid chips of the candidate colors", async () => {
    const image = await syntheticBottle();
    const palette = candidates(["#22BACC", "#111111", "#E8A0C8", "#FFFFFF"]);
    const composite = await renderPaletteComposite(image, palette);
    assert.equal(composite.contentType, "image/png");
    assert.ok(composite.dataUri.startsWith("data:image/png;base64,"));
    const meta = await sharp(composite.bytes).metadata();
    assert.equal(meta.width, composite.layout.width);
    assert.equal(meta.height, composite.layout.height);
    assert.deepEqual(composite.layout.photo, { x: 16, y: 16, width: 300, height: 400 });
    // Sample just inside each chip's border, away from the letter.
    for (const chip of composite.layout.chips) {
      assert.equal(await pixelAt(composite.bytes, chip.x + 6, chip.y + 6), chip.hex, `chip ${chip.label}`);
    }
    // The photo is really there: its top-left corner is the white background of the bottle shot.
    assert.equal(await pixelAt(composite.bytes, 20, 20), "#FFFFFF");
    // And the canvas background shows between photo and strip.
    assert.equal(await pixelAt(composite.bytes, 16 + 300 + 6, 20), PALETTE_PICK_DEFAULTS.background);
  });
});

// ── Prompt ───────────────────────────────────────────────────────────────────

describe("palette-pick — buildPalettePickPayload", () => {
  let savedDetail;
  beforeEach(() => {
    savedDetail = process.env.AZURE_OPENAI_VISION_DETAIL;
    delete process.env.AZURE_OPENAI_VISION_DETAIL;
  });
  afterEach(() => {
    if (savedDetail === undefined) delete process.env.AZURE_OPENAI_VISION_DETAIL;
    else process.env.AZURE_OPENAI_VISION_DETAIL = savedDetail;
  });

  it("asks for a JSON choice among the chip letters and attaches the composite", () => {
    const payload = buildPalettePickPayload("data:image/png;base64,AAAA", candidates(["#111111", "#222222", "#333333"]));
    assert.deepEqual(payload.response_format, { type: "json_object" });
    assert.equal(payload.temperature, 0);
    assert.equal(payload.messages[0].role, "system");
    assert.match(payload.messages[0].content, /A, B, C/);
    assert.match(payload.messages[0].content, /"choice"/);
    assert.match(payload.messages[0].content, /base lacquer/);
    const user = payload.messages[1].content;
    const image = user.find((part) => part.type === "image_url");
    assert.equal(image.image_url.url, "data:image/png;base64,AAAA");
    assert.equal(image.image_url.detail, "low");
    assert.doesNotMatch(JSON.stringify(payload), /#111111/, "chip hexes are not leaked into the prompt");
  });

  it("honors an explicit detail, then AZURE_OPENAI_VISION_DETAIL, and has a distinct safe prompt", () => {
    const explicit = buildPalettePickPayload("data:x", candidates(["#111111"]), false, "high");
    assert.equal(explicit.messages[1].content[1].image_url.detail, "high");
    process.env.AZURE_OPENAI_VISION_DETAIL = "auto";
    const fromEnv = buildPalettePickPayload("data:x", candidates(["#111111"]));
    assert.equal(fromEnv.messages[1].content[1].image_url.detail, "auto");
    const safe = buildPalettePickPayload("data:x", candidates(["#111111"]), true);
    assert.notEqual(safe.messages[0].content, explicit.messages[0].content);
    assert.match(safe.messages[0].content, /"choice"/);
  });
});

// ── Parsing ──────────────────────────────────────────────────────────────────

describe("palette-pick — parsePaletteChoice", () => {
  const palette = candidates(["#AA0000", "#00AA00", "#0000AA"]);

  it("maps a valid letter back to the measured hex with confidence and raw finishes", () => {
    const out = parsePaletteChoice('{"choice":"B","confidence":0.8,"finishes":["creme"]}', palette);
    assert.deepEqual(out, { choice: "B", hex: "#00AA00", confidence: 0.8, finishesRaw: ["creme"] });
  });

  it("normalizes sloppy choices: lowercase, punctuation, 'chip X', 1-based numbers", () => {
    assert.equal(normalizeChoiceLabel("b"), "B");
    assert.equal(normalizeChoiceLabel(" C. "), "C");
    assert.equal(normalizeChoiceLabel("chip B"), "B");
    assert.equal(normalizeChoiceLabel("Option A (the bottle)"), "A");
    assert.equal(normalizeChoiceLabel(2), "B");
    assert.equal(normalizeChoiceLabel("ABC"), null);
    assert.equal(normalizeChoiceLabel(null), null);
    assert.equal(parsePaletteChoice('{"choice":"c"}', palette).hex, "#0000AA");
    assert.equal(parsePaletteChoice('{"chip":"a"}', palette).hex, "#AA0000");
  });

  it("returns null hex (never a guess) for a letter that is not a chip", () => {
    const out = parsePaletteChoice('{"choice":"Z","confidence":0.9}', palette);
    assert.equal(out.hex, null);
    assert.equal(out.choice, "Z");
    assert.equal(out.reason, "unknown_label");
    assert.equal(out.confidence, 0.9);
  });

  it("reports a missing choice, clamps confidence, and tolerates non-object JSON", () => {
    const missing = parsePaletteChoice('{"confidence":7}', palette);
    assert.equal(missing.hex, null);
    assert.equal(missing.reason, "missing_choice");
    assert.equal(missing.confidence, 1);
    assert.equal(parsePaletteChoice("[1,2]", palette).reason, "unparseable");
    assert.equal(parsePaletteChoice("", palette).reason, "unparseable");
  });

  it("falls back to a regex for almost-JSON and gives up on garbage", () => {
    const loose = parsePaletteChoice('Sure! {"choice": "C", "confidence": 0.5', palette);
    assert.equal(loose.hex, "#0000AA");
    assert.equal(loose.choice, "C");
    assert.equal(loose.confidence, null);
    const garbage = parsePaletteChoice("The polish is a lovely teal.", palette);
    assert.equal(garbage.hex, null);
    assert.equal(garbage.reason, "unparseable");
  });
});

// ── End to end with a stubbed fetch ──────────────────────────────────────────

describe("palette-pick — detectHexByPalettePick", () => {
  const ENV_KEYS = ["AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_KEY", "AZURE_OPENAI_DEPLOYMENT_HEX", "AZURE_OPENAI_DEPLOYMENT", "AZURE_OPENAI_USE_GATEWAY", "AZURE_OPENAI_GATEWAY_ENDPOINT", "AZURE_OPENAI_GATEWAY_SUBSCRIPTION_KEY"];
  const savedEnv = {};
  let savedFetch;
  let calls;
  let image;

  before(async () => {
    image = await syntheticBottle();
  });
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    savedFetch = global.fetch;
    calls = [];
  });
  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    global.fetch = savedFetch;
  });

  function configure() {
    process.env.AZURE_OPENAI_ENDPOINT = "https://unit.openai.azure.com/";
    process.env.AZURE_OPENAI_KEY = "unit-test-key";
    process.env.AZURE_OPENAI_DEPLOYMENT_HEX = "gpt-vision";
  }

  function stubFetch(reply) {
    global.fetch = async (url, init) => {
      calls.push({ url: String(url), init, body: JSON.parse(init.body) });
      const content = typeof reply === "function" ? reply(calls.length) : reply;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content } }],
          usage: { prompt_tokens: 300, completion_tokens: 20, total_tokens: 320 },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    };
  }

  it("returns provider none without touching the image or the network when Azure OpenAI is not configured", async () => {
    stubFetch("unused");
    const result = await detectHexByPalettePick(image, quiet);
    assert.equal(result.provider, "none");
    assert.equal(result.reason, "missing_config");
    assert.equal(result.hex, null);
    assert.deepEqual(result.candidates, []);
    assert.equal(calls.length, 0);
  });

  it("sends the composite and maps the chosen letter to that chip's measured hex", async () => {
    configure();
    let chosen;
    stubFetch(() => JSON.stringify({ choice: chosen, confidence: 0.85, finishes: ["Creme", "holo", "bogus"] }));
    // Decide the answer from the candidates the library will build, so the test is independent of extraction details.
    const expected = await extractPaletteCandidates(image);
    const teal = expected.find((c) => colorDistance(c.hex, "#22BACC") < 0.02);
    chosen = teal.label;

    const result = await detectHexByPalettePick(image, { ...quiet, includeCompositeBytes: true });
    assert.equal(result.provider, "azure-openai");
    assert.equal(result.hex, teal.hex);
    assert.equal(result.choice, teal.label);
    assert.equal(result.confidence, 0.85);
    assert.deepEqual(result.finishes, ["creme", "holographic"], "finishes are canonicalized via the catalog");
    assert.deepEqual(result.candidates, expected);
    assert.deepEqual(result.usage, { promptTokens: 300, completionTokens: 20, totalTokens: 320 });
    assert.equal(result.reason, undefined);
    assert.ok(result.composite.width > 0 && result.composite.height > 0);
    assert.equal(result.composite.rows * result.composite.columns >= expected.length, true);
    assert.ok(Buffer.isBuffer(result.compositeBytes));

    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /^https:\/\/unit\.openai\.azure\.com\/openai\/deployments\/gpt-vision\/chat\/completions\?api-version=/);
    assert.equal(calls[0].init.headers["api-key"], "unit-test-key");
    const payload = calls[0].body;
    assert.deepEqual(payload.response_format, { type: "json_object" });
    const imagePart = payload.messages[1].content.find((p) => p.type === "image_url");
    assert.ok(imagePart.image_url.url.startsWith("data:image/png;base64,"));
    const sent = await sharp(Buffer.from(imagePart.image_url.url.split(",")[1], "base64")).metadata();
    assert.equal(sent.width, result.composite.width);
    assert.equal(sent.height, result.composite.height);
    assert.match(payload.messages[0].content, new RegExp(expected.map((c) => c.label).join(", ")));
  });

  it("returns a null hex (not a guess) when the model answers with an invalid or missing choice", async () => {
    configure();
    stubFetch(JSON.stringify({ choice: "Q", confidence: 0.4 }));
    const invalid = await detectHexByPalettePick(image, quiet);
    assert.equal(invalid.provider, "azure-openai");
    assert.equal(invalid.hex, null);
    assert.equal(invalid.choice, "Q");
    assert.equal(invalid.reason, "unknown_label");
    assert.ok(invalid.candidates.length > 0);
    assert.equal(invalid.rawContent, '{"choice":"Q","confidence":0.4}');

    stubFetch(JSON.stringify({ confidence: 0.4 }));
    const missing = await detectHexByPalettePick(image, quiet);
    assert.equal(missing.hex, null);
    assert.equal(missing.reason, "missing_choice");

    stubFetch("");
    const empty = await detectHexByPalettePick(image, quiet);
    assert.equal(empty.hex, null);
    assert.equal(empty.reason, "empty_response");
  });

  it("retries once with the safe prompt when the content filter rejects the composite", async () => {
    configure();
    let attempt = 0;
    global.fetch = async (url, init) => {
      attempt += 1;
      calls.push({ body: JSON.parse(init.body) });
      if (attempt === 1) {
        return new Response(JSON.stringify({ error: { code: "content_filter", message: "ResponsibleAIPolicyViolation" } }), { status: 400 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"choice":"A","confidence":0.6}' } }] }), { status: 200 });
    };
    const result = await detectHexByPalettePick(image, quiet);
    assert.equal(calls.length, 2);
    assert.notEqual(calls[0].body.messages[0].content, calls[1].body.messages[0].content, "second attempt uses the safe prompt");
    assert.equal(result.hex, result.candidates[0].hex);
    assert.equal(result.usage, null);
  });
});

// ── Eval strategy wiring ─────────────────────────────────────────────────────

describe("eval/hex palette-pick strategy", () => {
  it("is registered under the name palette-pick and needs Azure OpenAI", () => {
    assert.equal(getStrategy("palette-pick"), palettePickStrategy);
    assert.ok(STRATEGIES.includes(palettePickStrategy));
    assert.equal(palettePickStrategy.requiresAzureOpenAI, true);
  });

  it("records the palette, the choice and the composite size in meta", async () => {
    const saved = { fetch: global.fetch };
    const savedEnv = {};
    for (const key of ["AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_KEY", "AZURE_OPENAI_DEPLOYMENT_HEX"]) savedEnv[key] = process.env[key];
    process.env.AZURE_OPENAI_ENDPOINT = "https://unit.openai.azure.com";
    process.env.AZURE_OPENAI_KEY = "k";
    process.env.AZURE_OPENAI_DEPLOYMENT_HEX = "d";
    global.fetch = async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '{"choice":"A","confidence":0.7,"finishes":["creme"]}' } }], usage: { total_tokens: 5 } }), {
        status: 200,
      });
    try {
      const bytes = await syntheticBottle();
      const output = await palettePickStrategy.run({
        evalCase: { id: "t:1", brand: "T", shadeName: "One", finishes: ["creme"], groundTruthHex: "#22BACC", groundTruthSource: "manual", source: "Test", imageUrl: "https://x/y.png" },
        image: { bytes, contentType: "image/png", dataUri: `data:image/png;base64,${bytes.toString("base64")}`, sourceUrl: null },
      });
      assert.equal(output.hex, output.meta.candidates[0].hex);
      assert.equal(output.meta.choice, "A");
      assert.equal(output.confidence, 0.7);
      assert.deepEqual(output.finishes, ["creme"]);
      assert.ok(output.meta.composite.width > 0);
      assert.deepEqual(output.meta.usage, { promptTokens: null, completionTokens: null, totalTokens: 5 });
      assert.equal("rawContent" in output.meta, false, "raw content only kept for failures");
    } finally {
      global.fetch = saved.fetch;
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("throws when Azure OpenAI is not configured so the runner records an error instead of a silent miss", async () => {
    const savedEnv = {};
    for (const key of ["AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_KEY", "AZURE_OPENAI_GATEWAY_ENDPOINT", "AZURE_OPENAI_USE_GATEWAY"]) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    try {
      const bytes = await syntheticBottle();
      await assert.rejects(
        palettePickStrategy.run({ evalCase: {}, image: { bytes, contentType: "image/png", dataUri: "", sourceUrl: null } }),
        /Azure OpenAI config missing/
      );
    } finally {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

after(() => {
  Module._resolveFilename = originalResolve;
});
