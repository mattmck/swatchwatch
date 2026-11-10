/**
 * Vision read of the bottom sticker (`src/lib/sticker-read.ts`): when to read, the closed-set
 * prompt, parsing the model's answer, the OCR/vision merge and the best-effort call. No
 * network, no database: the chat call is replaced on the ai-color-detection exports.
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

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
  STICKER_READ_PROMPT_VERSION,
  STICKER_READ_OCR_MIN_CONFIDENCE,
  STICKER_READ_DEPLOYMENT_ENV_KEYS,
  shouldVisionRead,
  buildStickerReadPayload,
  parseStickerRead,
  readStickerWithVision,
  mergeLabelExtraction,
  BRAND_NAMES_PROMPT_CAP,
} = require("../dist/lib/sticker-read");

const quiet = { onLog: () => undefined };
const realRequest = aiColorDetection.requestAzureOpenAIChatCompletion;
const ENV_KEYS = ["AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_KEY", "AZURE_OPENAI_DEPLOYMENT_LABEL", "AZURE_OPENAI_DEPLOYMENT_HEX", "AZURE_OPENAI_DEPLOYMENT"];
const IMAGE = "data:image/png;base64,AAAA";
let savedEnv;
let chatCalls;
let chatImpl;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.AZURE_OPENAI_ENDPOINT = "https://unit.openai.azure.com/";
  process.env.AZURE_OPENAI_KEY = "unit-test-key";
  process.env.AZURE_OPENAI_DEPLOYMENT_LABEL = "gpt-label";
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

const answer = (content) => async () => ({ provider: "azure-openai", content, usage: null, deployment: "d" });
const UNICORN_JSON =
  '{"printedName":"unicorn skin","closestListed":"Unicorn Skin","brand":"Holo Taco","finish":"Holo","confidence":0.82}';
const baseInput = (overrides = {}) => ({
  imageDataUri: IMAGE,
  surface: "bottom",
  brandName: "Holo Taco",
  shadeNames: ["Unicorn Skin", "Linear Holo"],
  ...overrides,
});
const visionResult = (overrides = {}) => ({
  brand: null,
  brandListed: null,
  brandConfidence: null,
  printedName: null,
  closestListed: null,
  finish: null,
  gtin: null,
  confidence: 0,
  promptVersion: STICKER_READ_PROMPT_VERSION,
  closedSet: false,
  rawContent: "{}",
  ...overrides,
});
const userText = (payload) => payload.messages[1].content.find((part) => part.type === "text").text;
const systemText = (payload) => payload.messages[0].content;

describe("lib/sticker-read — constants", () => {
  it("pins the prompt version, OCR floor and deployment order", () => {
    assert.equal(STICKER_READ_PROMPT_VERSION, "sticker-read/2026-11-v2");
    assert.equal(BRAND_NAMES_PROMPT_CAP, 300);
    assert.equal(STICKER_READ_OCR_MIN_CONFIDENCE, 0.4);
    assert.deepEqual(STICKER_READ_DEPLOYMENT_ENV_KEYS, [
      "AZURE_OPENAI_DEPLOYMENT_LABEL",
      "AZURE_OPENAI_DEPLOYMENT_HEX",
      "AZURE_OPENAI_DEPLOYMENT",
    ]);
  });
});

describe("lib/sticker-read — shouldVisionRead", () => {
  it("reads when the brand is known, whatever the OCR said", () => {
    assert.equal(shouldVisionRead({ brandKnown: true, ocr: { rawText: "x", confidence: 0.9 } }), true);
  });
  it("reads when there is no OCR result", () => {
    assert.equal(shouldVisionRead({ brandKnown: false, ocr: null }), true);
  });
  it("reads when the OCR text is empty", () => {
    assert.equal(shouldVisionRead({ brandKnown: false, ocr: { rawText: "  ", confidence: 0.9 } }), true);
  });
  it("reads below the OCR confidence floor and not at it", () => {
    assert.equal(shouldVisionRead({ brandKnown: false, ocr: { rawText: "OPI", confidence: 0.39 } }), true);
    assert.equal(shouldVisionRead({ brandKnown: false, ocr: { rawText: "OPI", confidence: 0.4 } }), false);
  });
});

describe("lib/sticker-read — buildStickerReadPayload", () => {
  it("closed set: lists every name and asks for the closest one", () => {
    const payload = buildStickerReadPayload(baseInput({ shadeNames: ["Unicorn Skin", "Linear Holo", "Mermaid"] }), false);
    const text = userText(payload);
    for (const name of ["Unicorn Skin", "Linear Holo", "Mermaid"]) assert.ok(text.includes(name), name);
    assert.match(text, /closest/i);
    assert.match(systemText(payload), /Holo Taco/);
    assert.ok(payload.max_tokens <= 300);
    assert.deepEqual(payload.response_format, { type: "json_object" });
    assert.equal(payload.temperature, 0);
  });

  it("sends the image at the resolved detail, low by default", () => {
    const image = buildStickerReadPayload(baseInput(), false).messages[1].content.find((part) => part.type === "image_url");
    assert.equal(image.image_url.url, IMAGE);
    assert.equal(image.image_url.detail, "low");
    const high = buildStickerReadPayload(baseInput({ imageDetail: "high" }), false).messages[1].content.find((part) => part.type === "image_url");
    assert.equal(high.image_url.detail, "high");
  });

  it("lists the finish names the answer may use", () => {
    assert.match(userText(buildStickerReadPayload(baseInput(), false)), /holographic/);
  });

  it("names the photographed surface when known", () => {
    assert.match(systemText(buildStickerReadPayload(baseInput({ surface: "bottom" }), false)), /bottom of the bottle/);
    assert.doesNotMatch(systemText(buildStickerReadPayload(baseInput({ surface: null }), false)), /photo shows the/);
  });

  it("401 names: nothing is listed and the system text says the list is unavailable", () => {
    const names = Array.from({ length: 401 }, (_, i) => `Shade Number ${i}`);
    const payload = buildStickerReadPayload(baseInput({ shadeNames: names }), false);
    assert.ok(!userText(payload).includes("Shade Number 0"));
    assert.match(systemText(payload), /unavailable/i);
    assert.ok(payload.max_tokens <= 300);
  });

  it("400 names is still a closed set", () => {
    const names = Array.from({ length: 400 }, (_, i) => `Shade Number ${i}`);
    const text = userText(buildStickerReadPayload(baseInput({ shadeNames: names }), false));
    assert.ok(text.includes("Shade Number 399"));
  });

  it("open read: no names, closestListed is null", () => {
    const payload = buildStickerReadPayload(baseInput({ shadeNames: [], brandName: null }), false);
    assert.match(systemText(payload), /unavailable/i);
    assert.match(userText(payload), /closestListed/);
    assert.match(userText(payload), /null/);
  });

  it("v2: asks for a separate brand confidence and says the text may be rotated", () => {
    const payload = buildStickerReadPayload(baseInput(), false);
    assert.match(systemText(payload), /brandConfidence/);
    assert.match(systemText(payload), /rotated|sideways/i);
    assert.match(systemText(buildStickerReadPayload(baseInput(), true)), /brandConfidence/);
  });

  it("no known brand: lists the catalog brand names and asks for the printed one", () => {
    const payload = buildStickerReadPayload(
      baseInput({ surface: "front", brandName: null, shadeNames: [], brandNames: ["ILNP", "KBShimmer", "Kiss"] }),
      false
    );
    const text = userText(payload);
    for (const name of ["ILNP", "KBShimmer", "Kiss"]) assert.ok(text.includes(name), name);
    assert.match(text, /brandListed/);
    assert.match(text, /printed/i);
    assert.match(userText(buildStickerReadPayload(baseInput({ brandName: null, shadeNames: [], brandNames: ["ILNP"] }), true)), /ILNP/);
  });

  it("a known brand, no brand names or too many: no brand list, brandListed is null", () => {
    const known = userText(buildStickerReadPayload(baseInput({ brandNames: ["ILNP", "KBShimmer"] }), false));
    assert.ok(!known.includes("KBShimmer"));
    assert.match(known, /brandListed: null/);
    const none = userText(buildStickerReadPayload(baseInput({ brandName: null, shadeNames: [] }), false));
    assert.match(none, /brandListed: null/);
    const many = Array.from({ length: 301 }, (_, i) => `Brand ${i}`);
    const tooMany = userText(buildStickerReadPayload(baseInput({ brandName: null, shadeNames: [], brandNames: many }), false));
    assert.ok(!tooMany.includes("Brand 0"));
    assert.match(tooMany, /brandListed: null/);
  });

  it("the safe prompt keeps the answer shape and the list", () => {
    const payload = buildStickerReadPayload(baseInput(), true);
    assert.match(userText(payload), /Unicorn Skin/);
    assert.match(userText(payload), /printedName/);
    assert.deepEqual(payload.response_format, { type: "json_object" });
  });
});

describe("lib/sticker-read — parseStickerRead", () => {
  it("returns the listed spelling, a canonical finish and the confidence", () => {
    const parsed = parseStickerRead(UNICORN_JSON, ["Unicorn Skin", "Linear Holo"]);
    assert.equal(parsed.closestListed, "Unicorn Skin");
    assert.equal(parsed.printedName, "unicorn skin");
    assert.equal(parsed.brand, "Holo Taco");
    assert.equal(parsed.finish, "holographic");
    assert.equal(parsed.confidence, 0.82);
    assert.equal(parsed.brandConfidence, 0.82);
  });

  it("matches the listed name case-insensitively and returns its listed casing", () => {
    const parsed = parseStickerRead('{"printedName":"Unicorn Skin","closestListed":"  unicorn   SKIN ","confidence":0.7}', ["Unicorn Skin"]);
    assert.equal(parsed.closestListed, "Unicorn Skin");
  });

  it("a name that is not listed is null", () => {
    assert.equal(parseStickerRead('{"printedName":"Not Listed","closestListed":"Not Listed","confidence":0.7}', ["Unicorn Skin"]).closestListed, null);
    assert.equal(parseStickerRead('{"printedName":"Unicorn Skin","closestListed":"Unicorn Skin","confidence":0.7}', []).closestListed, null);
  });

  it("a listed pick without a printed name is a guess and is dropped", () => {
    const parsed = parseStickerRead('{"printedName":null,"closestListed":"Unicorn Skin","brand":"Holo Taco","confidence":0.9}', ["Unicorn Skin"]);
    assert.equal(parsed.closestListed, null);
    assert.equal(parsed.brand, "Holo Taco");
  });

  it("invalid JSON: every field null and confidence 0", () => {
    assert.deepEqual(parseStickerRead("not json", ["Unicorn Skin"]), {
      brand: null,
      brandListed: null,
      brandConfidence: null,
      printedName: null,
      closestListed: null,
      finish: null,
      gtin: null,
      confidence: 0,
    });
  });

  it("v2: the brand confidence is the model's brandConfidence, else the read's confidence", () => {
    const own = parseStickerRead('{"printedName":null,"brand":"ILNP","brandConfidence":0.95,"confidence":0.45}', []);
    assert.equal(own.brandConfidence, 0.95);
    assert.equal(own.confidence, 0.45);
    const fallback = parseStickerRead('{"printedName":null,"brand":"ILNP","confidence":0.45}', []);
    assert.equal(fallback.brandConfidence, 0.45);
    assert.equal(parseStickerRead('{"brand":null,"brandConfidence":0.9,"confidence":0.4}', []).brandConfidence, null);
  });

  it("brandListed: a listed brand, in its listed spelling, only when a brand is printed", () => {
    const opts = { brandNames: ["ILNP", "KBShimmer"] };
    const picked = parseStickerRead('{"brand":"kbshimmer","brandListed":" kbshimmer ","brandConfidence":0.9,"confidence":0.6}', [], undefined, opts);
    assert.equal(picked.brandListed, "KBShimmer");
    assert.equal(picked.brand, "kbshimmer");
    const unlisted = parseStickerRead('{"brand":"Hush Hush","brandListed":"Hush Hush","confidence":0.9}', [], undefined, opts);
    assert.equal(unlisted.brandListed, null);
    assert.equal(unlisted.brand, "Hush Hush");
    const guess = parseStickerRead('{"brand":null,"brandListed":"KBShimmer","confidence":0.9}', [], undefined, opts);
    assert.equal(guess.brandListed, null, "a pick with no printed brand is a guess");
    assert.equal(parseStickerRead('{"brand":"ILNP","brandListed":"ILNP","confidence":0.9}', []).brandListed, null, "no list, no pick");
  });

  it("the brand the prompt named, echoed back, is no evidence; another brand is", () => {
    const echo = parseStickerRead('{"printedName":"Sleet Deal","brand":"kb shimmer","confidence":0.58}', [], undefined, { givenBrand: "KBShimmer" });
    assert.equal(echo.brand, null);
    assert.equal(echo.brandConfidence, null);
    assert.equal(echo.printedName, "Sleet Deal");
    const other = parseStickerRead('{"printedName":"Sleet Deal","brand":"ILNP","confidence":0.9}', [], undefined, { givenBrand: "Kiss" });
    assert.equal(other.brand, "ILNP");
  });

  it("the string \"null\" (any case) and other placeholders are no value", () => {
    const parsed = parseStickerRead('{"printedName":"null","closestListed":"NULL","brand":"null","brandListed":"null","finish":"null","gtin":"null","confidence":0.8}', ["Null"], undefined, { brandNames: ["Null"] });
    assert.equal(parsed.printedName, null);
    assert.equal(parsed.closestListed, null);
    assert.equal(parsed.brand, null);
    assert.equal(parsed.brandListed, null);
    assert.equal(parsed.brandConfidence, null);
    assert.equal(parseStickerRead('{"printedName":"N/A","brand":"none","confidence":0.8}', []).printedName, null);
    assert.equal(parseStickerRead('{"printedName":"N/A","brand":"none","confidence":0.8}', []).brand, null);
  });

  it("accepts JSON inside a code fence", () => {
    assert.equal(parseStickerRead("```json\n" + UNICORN_JSON + "\n```", ["Unicorn Skin"]).closestListed, "Unicorn Skin");
  });

  it("drops an unknown finish, a non-digit gtin and blank strings", () => {
    const parsed = parseStickerRead('{"printedName":"  ","brand":"","finish":"sparkly-ish","gtin":"ABC","confidence":0.5}', []);
    assert.equal(parsed.printedName, null);
    assert.equal(parsed.brand, null);
    assert.equal(parsed.finish, null);
    assert.equal(parsed.gtin, null);
    assert.equal(parsed.brandConfidence, null);
  });

  it("keeps a digits-only gtin of a valid length", () => {
    assert.equal(parseStickerRead('{"gtin":"0 12345-67890 5","confidence":0.5}', []).gtin, "012345678905");
    assert.equal(parseStickerRead('{"gtin":"12345","confidence":0.5}', []).gtin, null);
  });

  it("clamps the confidence and tolerates a missing one", () => {
    assert.equal(parseStickerRead('{"printedName":"A","confidence":4}', []).confidence, 1);
    assert.equal(parseStickerRead('{"printedName":"A"}', []).confidence, 0.5);
  });
});

describe("lib/sticker-read — readStickerWithVision", () => {
  it("returns the parsed read with the prompt version and closed-set flag", async () => {
    chatImpl = answer(UNICORN_JSON);
    const result = await readStickerWithVision(baseInput(), quiet);
    assert.equal(chatCalls.length, 1);
    assert.equal(result.closestListed, "Unicorn Skin");
    assert.equal(result.closedSet, true);
    assert.equal(result.promptVersion, STICKER_READ_PROMPT_VERSION);
    assert.equal(result.rawContent, UNICORN_JSON);
    assert.deepEqual(chatCalls[0].request.deploymentEnvKeys, STICKER_READ_DEPLOYMENT_ENV_KEYS);
  });

  it("drops the echo of the brand it was told and passes the brand names on", async () => {
    chatImpl = answer(UNICORN_JSON);
    const told = await readStickerWithVision(baseInput(), quiet);
    assert.equal(told.brand, null, "Holo Taco was in the prompt");
    chatImpl = answer('{"printedName":null,"brand":"kb shimmer","brandListed":"KBShimmer","brandConfidence":0.9,"confidence":0.5}');
    const open = await readStickerWithVision(baseInput({ surface: "front", brandName: null, shadeNames: [], brandNames: ["ILNP", "KBShimmer"] }), quiet);
    assert.equal(open.brandListed, "KBShimmer");
    assert.equal(open.brandConfidence, 0.9);
    assert.match(userText(chatCalls[1].request.buildPayload(false)), /KBShimmer/);
  });

  it("no names: an open read", async () => {
    chatImpl = answer('{"printedName":"Mermaid","closestListed":"Mermaid","confidence":0.6}');
    const result = await readStickerWithVision(baseInput({ shadeNames: [] }), quiet);
    assert.equal(result.closedSet, false);
    assert.equal(result.closestListed, null);
    assert.equal(result.printedName, "Mermaid");
  });

  it("provider none (no config at call time) is null", async () => {
    chatImpl = async () => ({ provider: "none", content: null, usage: null, deployment: null, reason: "missing_config" });
    assert.equal(await readStickerWithVision(baseInput(), quiet), null);
  });

  it("null content is null", async () => {
    chatImpl = async () => ({ provider: "azure-openai", content: null, usage: null, deployment: "d", reason: "content_filtered" });
    assert.equal(await readStickerWithVision(baseInput(), quiet), null);
  });

  it("a throwing call is null and logged", async () => {
    chatImpl = async () => {
      throw new Error("boom");
    };
    const logs = [];
    assert.equal(await readStickerWithVision(baseInput(), { onLog: (level, message) => logs.push([level, message]) }), null);
    assert.ok(logs.some(([level, message]) => level === "warn" && /boom/.test(message)));
  });

  it("missing configuration: no call at all", async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    assert.equal(await readStickerWithVision(baseInput(), quiet), null);
    assert.equal(chatCalls.length, 0);
  });

  it("reports the model call through onModelCall", async () => {
    chatImpl = answer(UNICORN_JSON);
    let calls = 0;
    await readStickerWithVision(baseInput(), { ...quiet, onModelCall: () => (calls += 1) });
    assert.equal(calls, 1);
  });
});

describe("lib/sticker-read — mergeLabelExtraction", () => {
  it("OCR keeps a field when its confidence is higher", () => {
    const merged = mergeLabelExtraction(
      { fields: { brand: "OPI", shadeName: "Big Apple" }, confidence: 0.9 },
      visionResult({ brand: "Opi", printedName: "Big Apple Red", confidence: 0.6 })
    );
    assert.equal(merged.extracted.shadeName, "Big Apple");
    assert.equal(merged.extracted.brand, "OPI");
    assert.equal(merged.sources.shadeName, "ocr");
    assert.equal(merged.extracted.source, undefined);
  });

  it("vision wins a field when its confidence is higher or equal, and marks the source", () => {
    const higher = mergeLabelExtraction(
      { fields: { brand: "OPI", shadeName: "Big Apple" }, confidence: 0.6 },
      visionResult({ printedName: "Big Apple Red", confidence: 0.9 })
    );
    assert.equal(higher.extracted.shadeName, "Big Apple Red");
    assert.equal(higher.sources.shadeName, "vision");
    assert.equal(higher.sources.brand, "ocr");
    assert.equal(higher.extracted.brand, "OPI");
    assert.equal(higher.extracted.source, "vision");

    const tie = mergeLabelExtraction(
      { fields: { shadeName: "Big Apple" }, confidence: 0.7 },
      visionResult({ printedName: "Big Apple Red", confidence: 0.7 })
    );
    assert.equal(tie.extracted.shadeName, "Big Apple Red");
  });

  it("a model-read gtin with a wrong check digit is no evidence", () => {
    const merged = mergeLabelExtraction(null, visionResult({ gtin: "012345678906", printedName: "A", confidence: 0.9 }));
    assert.equal(merged.extracted.gtin, undefined);
    assert.equal(merged.sources.gtin, undefined);
    const kept = mergeLabelExtraction({ fields: { gtin: "4006381333931" }, confidence: 0.1 }, visionResult({ gtin: "4006381333932", confidence: 0.9 }));
    assert.equal(kept.extracted.gtin, "4006381333931", "the invalid vision read does not replace OCR's");
  });

  it("a field only one side has is used whatever the confidences", () => {
    const merged = mergeLabelExtraction(
      { fields: { brand: "OPI", collection: "Fall", sizeMl: 15 }, confidence: 0.95 },
      visionResult({ finish: "holographic", gtin: "012345678905", confidence: 0.2 })
    );
    assert.equal(merged.extracted.finish, "holographic");
    assert.equal(merged.sources.finish, "vision");
    assert.equal(merged.extracted.gtin, "012345678905");
    assert.equal(merged.extracted.collection, "Fall");
    assert.equal(merged.extracted.sizeMl, 15);
    assert.equal(merged.sources.collection, "ocr");
  });

  it("shadeNameListed always comes from vision; an OCR-won brand carries the OCR parse confidence", () => {
    const merged = mergeLabelExtraction(
      { fields: { brand: "OPI", shadeName: "Big Apple" }, confidence: 0.99 },
      visionResult({ brand: "Opi", brandConfidence: 0.3, closestListed: "Big Apple Red", confidence: 0.3 })
    );
    assert.equal(merged.extracted.shadeNameListed, "Big Apple Red");
    assert.equal(merged.extracted.brand, "OPI");
    assert.equal(merged.extracted.brandConfidence, 0.99, "the confidence of the brand that won, not vision's 0.3");
    assert.equal(merged.sources.brandConfidence, "ocr");
    assert.equal(merged.extracted.source, "vision");
  });

  it("a vision-won brand carries the vision brand confidence", () => {
    const merged = mergeLabelExtraction(
      { fields: { brand: "OPI" }, confidence: 0.4 },
      visionResult({ brand: "Holo Taco", brandConfidence: 0.85, confidence: 0.85 })
    );
    assert.equal(merged.extracted.brand, "Holo Taco");
    assert.equal(merged.extracted.brandConfidence, 0.85);
    assert.equal(merged.sources.brandConfidence, "vision");
  });

  it("no vision: the OCR fields as they were, the brand scored with the OCR parse confidence", () => {
    const merged = mergeLabelExtraction({ fields: { brand: "OPI", shadeName: null }, confidence: 0.5 }, null);
    assert.deepEqual(merged.extracted, { brand: "OPI", brandConfidence: 0.5 });
    assert.deepEqual(merged.sources, { brand: "ocr", brandConfidence: "ocr" });
  });

  it("no OCR: the vision fields only", () => {
    const merged = mergeLabelExtraction(null, visionResult({ brand: "Holo Taco", brandConfidence: 0.8, printedName: "Unicorn Skin", closestListed: "Unicorn Skin", confidence: 0.8 }));
    assert.equal(merged.extracted.brand, "Holo Taco");
    assert.equal(merged.extracted.shadeName, "Unicorn Skin");
    assert.equal(merged.extracted.shadeNameListed, "Unicorn Skin");
    assert.equal(merged.extracted.source, "vision");
  });

  it("a listed brand wins as the brand text, with the brand confidence", () => {
    const merged = mergeLabelExtraction(null, visionResult({ brand: "kbs", brandListed: "KBShimmer", brandConfidence: 0.88, confidence: 0.5 }));
    assert.equal(merged.extracted.brand, "KBShimmer");
    assert.equal(merged.extracted.brandConfidence, 0.88);
    assert.equal(merged.sources.brand, "vision");
  });

  it("neither side: empty", () => {
    assert.deepEqual(mergeLabelExtraction(null, null), { extracted: {}, sources: {} });
  });
});
