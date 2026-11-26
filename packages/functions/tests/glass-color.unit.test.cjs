/**
 * Glass color evidence (`src/lib/glass-color.ts`): the hex of the lacquer measured from a
 * hand-held bottle frame. Palette chips are measured from the pixels, the vision model picks
 * one, and a deterministic skin/grey-avoiding rule picks when the model cannot. No network,
 * no database: the chat call is replaced on the ai-color-detection exports.
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
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
  query: async () => ({ rows: [], rowCount: 0 }),
  transaction: async (cb) => cb({ query: dbMock.query }),
  getPool: () => ({}),
  closePool: async () => {},
};
registerMock(path.resolve(__dirname, "../dist/lib/db.js"), dbMock);
registerMock("../lib/db", dbMock);

const aiColorDetection = require("../dist/lib/ai-color-detection");
const {
  GLASS_HEX_METHOD_PALETTE_PICK,
  GLASS_HEX_METHOD_FALLBACK,
  GLASS_HEX_FALLBACK_CONFIDENCE,
  GLASS_PROMPT_VERSION,
  GLASS_FALLBACK_TOP_BY_AREA,
  SKIN_TONE_REFERENCE_HEXES,
  GLASS_SKIN_GUARD_DISTANCE,
  GLASS_SKIN_DOMINANT_FRACTION,
  isSkinGuarded,
  pickFallbackChip,
  buildGlassPalettePayload,
  measureGlassHex,
} = require("../dist/lib/glass-color");

const quiet = { onLog: () => undefined };
const realRequest = aiColorDetection.requestAzureOpenAIChatCompletion;
const ENV_KEYS = ["AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_KEY", "AZURE_OPENAI_DEPLOYMENT_HEX", "AZURE_OPENAI_DEPLOYMENT"];
let savedEnv;
let chatCalls;
let chatImpl;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.AZURE_OPENAI_ENDPOINT = "https://unit.openai.azure.com/";
  process.env.AZURE_OPENAI_KEY = "unit-test-key";
  process.env.AZURE_OPENAI_DEPLOYMENT_HEX = "gpt-vision";
  chatCalls = [];
  chatImpl = async () => ({ provider: "none", content: null, usage: null, deployment: null, reason: "missing_config" });
  aiColorDetection.requestAzureOpenAIChatCompletion = async (request, options) => {
    chatCalls.push({ request, options });
    return chatImpl(request, options);
  };
});
afterEach(() => {
  aiColorDetection.requestAzureOpenAIChatCompletion = realRequest;
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

const chip = (label, hex, fraction) => ({ label, hex, fraction });
const answer = (content) => async () => ({ provider: "azure-openai", content, usage: null, deployment: "d" });

/** Left half skin, right half magenta: two chips, skin is the larger one only when `skinShare` > 0.5. */
async function skinAndMagenta(skinShare = 0.5) {
  const width = 64;
  const skinWidth = Math.round(width * skinShare);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="64">` +
    `<rect width="${skinWidth}" height="64" fill="#F0C8A0"/>` +
    `<rect x="${skinWidth}" width="${width - skinWidth}" height="64" fill="#B4004E"/>` +
    "</svg>";
  return sharp(Buffer.from(svg)).png().toBuffer();
}

describe("glass-color constants", () => {
  it("pins the documented values", () => {
    assert.equal(GLASS_HEX_METHOD_PALETTE_PICK, "palette-pick-bottle");
    assert.equal(GLASS_HEX_METHOD_FALLBACK, "palette-top");
    assert.equal(GLASS_HEX_FALLBACK_CONFIDENCE, 0.3);
    assert.equal(GLASS_PROMPT_VERSION, "glass-palette-pick/2026-11-v2");
    assert.equal(GLASS_SKIN_GUARD_DISTANCE, 0.04);
    assert.equal(GLASS_SKIN_DOMINANT_FRACTION, 0.3);
    assert.equal(GLASS_FALLBACK_TOP_BY_AREA, 3);
    assert.deepEqual(
      [...SKIN_TONE_REFERENCE_HEXES],
      ["#FFDFC4", "#F0C8A0", "#D9A077", "#B07B52", "#8D5524", "#5C3A1E"]
    );
  });
});

describe("glass-color — pickFallbackChip", () => {
  const A = chip("A", "#F0C8A0", 0.5);
  const B = chip("B", "#808080", 0.3);
  const C = chip("C", "#B4004E", 0.15);
  const D = chip("D", "#0000FF", 0.05);

  it("skips skin and grey and ignores chips outside the top three by area", () => {
    assert.equal(pickFallbackChip([A, B, C, D]).label, "C");
  });

  it("still returns a chip when every candidate is skin or grey", () => {
    const picked = pickFallbackChip([A, B, chip("C", "#D9A077", 0.1)]);
    assert.ok(picked, "never null with candidates");
    assert.ok(["A", "B", "C"].includes(picked.label));
  });

  it("returns null without candidates", () => {
    assert.equal(pickFallbackChip([]), null);
  });

  it("is deterministic across input orders", () => {
    const first = pickFallbackChip([A, B, C, D]);
    const second = pickFallbackChip([D, C, B, A]);
    assert.deepEqual(first, second);
  });

  it("breaks ties by larger fraction, then label order", () => {
    const x = chip("A", "#808080", 0.2);
    const y = chip("B", "#808080", 0.4);
    assert.equal(pickFallbackChip([x, y]).label, "B");
    const p = chip("A", "#808080", 0.3);
    const q = chip("B", "#808080", 0.3);
    assert.equal(pickFallbackChip([q, p]).label, "A");
  });
});

describe("glass-color — isSkinGuarded (the hand, not a nude lacquer)", () => {
  // Real chips from the bottle eval (2026-11-10), measured on the glass guide region.
  it("a minor skin chip at the edge of the region is the hand", () => {
    const hand = chip("D", "#F7C7B8", 0.04);
    const lacquer = chip("A", "#383559", 0.11);
    assert.equal(isSkinGuarded(hand, [lacquer, hand]), true);
    assert.equal(isSkinGuarded(lacquer, [lacquer, hand]), false);
  });

  it("a nude lacquer that fills the region is kept (Lily Rose, Donut Spunk, Latte)", () => {
    const lilyRose = [chip("A", "#F6CAB7", 0.51), chip("B", "#B68964", 0.12), chip("C", "#EABBA9", 0.1)];
    assert.equal(isSkinGuarded(lilyRose[0], lilyRose), false);
    const donutSpunk = [chip("A", "#E7C7A8", 0.56), chip("B", "#D5BCA5", 0.05)];
    assert.equal(isSkinGuarded(donutSpunk[0], donutSpunk), false);
    const latte = [chip("A", "#F9BA92", 0.35), chip("B", "#552817", 0.2), chip("C", "#E9AA89", 0.17)];
    assert.equal(isSkinGuarded(latte[0], latte), false);
  });

  it("a skin chip that is not the largest is guarded even when large", () => {
    const candidates = [chip("A", "#3A3835", 0.4), chip("B", "#F8D5B8", 0.35)];
    assert.equal(isSkinGuarded(candidates[1], candidates), true);
  });

  it("orange and brown lacquers farther than the guard distance are never guarded", () => {
    const candidates = [chip("A", "#C98507", 0.28), chip("B", "#B87705", 0.31)];
    assert.equal(isSkinGuarded(candidates[0], candidates), false);
  });

  it("largestUnguardedChip: the nude lacquer, not a darker chip (Le Mini Macaron Latte, sample 87)", () => {
    const { largestUnguardedChip } = require("../dist/lib/glass-color");
    const latte = [chip("A", "#F9BA92", 0.35), chip("B", "#552817", 0.2), chip("C", "#F7C7B8", 0.12)];
    assert.equal(isSkinGuarded(latte[2], latte), true, "the model's pick, a minor skin-near chip");
    assert.equal(largestUnguardedChip(latte).label, "A");
    assert.equal(largestUnguardedChip([chip("A", "#F8D5B8", 0.2), chip("B", "#F7C7B8", 0.1)]), null);
  });

  it("pickFallbackChip never answers a guarded chip when another chip exists", () => {
    const candidates = [chip("A", "#F8D5B8", 0.25), chip("B", "#808080", 0.2), chip("C", "#5A3537", 0.24)];
    assert.notEqual(pickFallbackChip(candidates).label, "A");
  });
});

describe("glass-color — buildGlassPalettePayload", () => {
  const candidates = [chip("A", "#F0C8A0", 0.5), chip("B", "#B4004E", 0.3), chip("C", "#808080", 0.2)];
  const uri = "data:image/png;base64,AAAA";

  it("is a deterministic JSON request that names every chip", () => {
    const payload = buildGlassPalettePayload(uri, candidates, false, "low");
    assert.equal(payload.temperature, 0);
    assert.deepEqual(payload.response_format, { type: "json_object" });
    const [system, user] = payload.messages;
    assert.match(system.content, /glass/i);
    assert.match(system.content, /cap/i);
    const userText = user.content.find((part) => part.type === "text").text;
    for (const letter of ["A", "B", "C"]) assert.ok(userText.includes(letter));
    const image = user.content.find((part) => part.type === "image_url");
    assert.deepEqual(image.image_url, { url: uri, detail: "low" });
  });

  it("safePrompt yields shorter text", () => {
    const normal = buildGlassPalettePayload(uri, candidates, false, "low");
    const safe = buildGlassPalettePayload(uri, candidates, true, "low");
    const size = (p) => p.messages[0].content.length + p.messages[1].content.find((x) => x.type === "text").text.length;
    assert.ok(size(safe) < size(normal));
  });
});

describe("glass-color — measureGlassHex", () => {
  it("uses the chip the model picks", async () => {
    const image = await skinAndMagenta();
    chatImpl = async (request) => {
      // Letters are assigned by the extractor; read them back from the prompt payload.
      const payload = request.buildPayload(false);
      const userText = payload.messages[1].content.find((p) => p.type === "text").text;
      assert.match(userText, /A.*B/);
      return answer('{"choice":"B","confidence":0.9}')();
    };
    const result = await measureGlassHex(image, quiet);
    assert.ok(result);
    assert.equal(result.method, GLASS_HEX_METHOD_PALETTE_PICK);
    assert.equal(result.promptVersion, GLASS_PROMPT_VERSION);
    assert.equal(result.confidence, 0.9);
    assert.equal(result.audit.modelCalls, 1);
    assert.equal(result.audit.choice, "B");
    const chipB = result.audit.candidates.find((c) => c.label === "B");
    assert.equal(result.hex, chipB.hex);
    assert.match(result.hex, /^#[0-9A-F]{6}$/);
    assert.equal(chatCalls.length, 1);
    assert.equal(chatCalls[0].request.usageMetricPrefix, "glass_color.palette_pick");
  });

  it("model unconfigured: no call, deterministic fallback", async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    const result = await measureGlassHex(await skinAndMagenta(), quiet);
    assert.equal(result.method, GLASS_HEX_METHOD_FALLBACK);
    assert.equal(result.audit.modelCalls, 0);
    assert.equal(result.audit.reason, "missing_config");
    assert.equal(chatCalls.length, 0);
  });

  it("provider none: deterministic fallback, no model call counted", async () => {
    const image = await skinAndMagenta();
    const result = await measureGlassHex(image, quiet);
    assert.equal(result.method, GLASS_HEX_METHOD_FALLBACK);
    assert.equal(result.confidence, GLASS_HEX_FALLBACK_CONFIDENCE);
    assert.equal(result.audit.modelCalls, 0);
    assert.equal(result.promptVersion, GLASS_PROMPT_VERSION);
    // The magenta chip, not the skin one, even though they are equal in area.
    assert.ok(Math.abs(parseInt(result.hex.slice(1, 3), 16) - 0xb4) < 24);
    assert.ok(parseInt(result.hex.slice(3, 5), 16) < 24);
  });

  it("an unknown letter falls back and records why", async () => {
    chatImpl = answer('{"choice":"Z","confidence":0.9}');
    const result = await measureGlassHex(await skinAndMagenta(), quiet);
    assert.equal(result.method, GLASS_HEX_METHOD_FALLBACK);
    assert.equal(result.audit.modelCalls, 1);
    assert.equal(result.audit.reason, "unknown_label");
  });

  it("the model declining (empty content) falls back", async () => {
    chatImpl = async () => ({ provider: "azure-openai", content: null, usage: null, deployment: "d", reason: "content_filtered" });
    const result = await measureGlassHex(await skinAndMagenta(), quiet);
    assert.equal(result.method, GLASS_HEX_METHOD_FALLBACK);
    assert.equal(result.audit.modelCalls, 1);
    assert.equal(result.audit.reason, "content_filtered");
  });

  it("a throwing model falls back and never throws", async () => {
    chatImpl = async () => {
      throw new Error("429 exhausted");
    };
    const result = await measureGlassHex(await skinAndMagenta(), quiet);
    assert.equal(result.method, GLASS_HEX_METHOD_FALLBACK);
    assert.equal(result.audit.modelCalls, 1);
    assert.equal(result.audit.reason, "model_error");
    assert.equal(chatCalls.length, 1, "one call at most");
  });

  it("measures only the guide region when one is given", async () => {
    // Skin all around, a magenta square in the middle: the whole frame is mostly skin.
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">' +
      '<rect width="100" height="100" fill="#F0C8A0"/><rect x="35" y="35" width="30" height="30" fill="#B4004E"/></svg>';
    const image = await sharp(Buffer.from(svg)).png().toBuffer();
    const whole = await measureGlassHex(image, quiet);
    assert.ok(whole.audit.candidates.some((c) => c.fraction > 0.5), "the whole frame is mostly skin");
    const region = await measureGlassHex(image, { ...quiet, region: { x: 0.38, y: 0.38, w: 0.24, h: 0.24 } });
    assert.ok(region);
    assert.ok(parseInt(region.hex.slice(1, 3), 16) > 0x90 && parseInt(region.hex.slice(3, 5), 16) < 0x30, `magenta, got ${region.hex}`);
    for (const candidate of region.audit.candidates) assert.ok(candidate.hex !== "#F0C8A0");
  });

  it("a model pick of the hand is replaced by the lacquer (reason skin_guard)", async () => {
    // 20% skin at the edge, 80% magenta: the model answers the skin chip.
    const image = await skinAndMagenta(0.2);
    chatImpl = async (request) => {
      const payload = request.buildPayload(false);
      const userText = payload.messages[1].content.find((p) => p.type === "text").text;
      assert.ok(userText.length > 0);
      return answer('{"choice":"__SKIN__","confidence":0.9}')();
    };
    // Resolve the skin chip's letter first (the extractor assigns them).
    const probe = await measureGlassHex(image, quiet);
    const skinLabel = probe.audit.candidates.find((c) => parseInt(c.hex.slice(3, 5), 16) > 0x90).label;
    chatImpl = answer(`{"choice":"${skinLabel}","confidence":0.9}`);
    const result = await measureGlassHex(image, quiet);
    assert.equal(result.method, GLASS_HEX_METHOD_FALLBACK);
    assert.equal(result.audit.reason, "skin_guard");
    assert.equal(result.audit.choice, skinLabel);
    assert.ok(parseInt(result.hex.slice(3, 5), 16) < 0x30, `magenta, got ${result.hex}`);
  });

  it("a model pick of a dominant nude chip is kept", async () => {
    const image = await skinAndMagenta(0.8);
    const probe = await measureGlassHex(image, quiet);
    const nude = probe.audit.candidates.find((c) => parseInt(c.hex.slice(3, 5), 16) > 0x90);
    chatImpl = answer(`{"choice":"${nude.label}","confidence":0.9}`);
    const result = await measureGlassHex(image, quiet);
    assert.equal(result.method, GLASS_HEX_METHOD_PALETTE_PICK);
    assert.equal(result.hex, nude.hex);
  });

  it("a 1x1 image cannot be measured", async () => {
    const tiny = await sharp({ create: { width: 1, height: 1, channels: 3, background: "#B4004E" } }).png().toBuffer();
    assert.equal(await measureGlassHex(tiny, quiet), null);
    assert.equal(chatCalls.length, 0);
  });

  it("bytes that are not an image return null", async () => {
    assert.equal(await measureGlassHex(Buffer.from("not an image"), quiet), null);
  });
});
