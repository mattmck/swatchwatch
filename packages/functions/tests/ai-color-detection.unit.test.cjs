const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const { buildHexDetectionRequestPayload } = require("../dist/lib/ai-color-detection");

function imagePart(payload) {
  const userContent = payload.messages.find((m) => m.role === "user").content;
  return userContent.find((part) => part.type === "image_url");
}

describe("lib/ai-color-detection — buildHexDetectionRequestPayload image detail", () => {
  let savedDetail;

  beforeEach(() => {
    savedDetail = process.env.AZURE_OPENAI_VISION_DETAIL;
    delete process.env.AZURE_OPENAI_VISION_DETAIL;
  });

  afterEach(() => {
    if (savedDetail === undefined) {
      delete process.env.AZURE_OPENAI_VISION_DETAIL;
    } else {
      process.env.AZURE_OPENAI_VISION_DETAIL = savedDetail;
    }
  });

  it("defaults to low detail for the standard prompt", () => {
    const part = imagePart(buildHexDetectionRequestPayload("https://img.example.com/a.jpg"));

    assert.equal(part.image_url.url, "https://img.example.com/a.jpg");
    assert.equal(part.image_url.detail, "low");
  });

  it("defaults to low detail for the safe (content-filter retry) prompt", () => {
    const part = imagePart(buildHexDetectionRequestPayload("https://img.example.com/a.jpg", undefined, true));

    assert.equal(part.image_url.detail, "low");
  });

  for (const value of ["high", "auto", "low"]) {
    it(`honors AZURE_OPENAI_VISION_DETAIL=${value}`, () => {
      process.env.AZURE_OPENAI_VISION_DETAIL = value;
      const part = imagePart(buildHexDetectionRequestPayload("https://img.example.com/a.jpg"));

      assert.equal(part.image_url.detail, value);
    });
  }

  it("normalizes case and whitespace", () => {
    process.env.AZURE_OPENAI_VISION_DETAIL = "  HIGH ";
    const part = imagePart(buildHexDetectionRequestPayload("https://img.example.com/a.jpg"));

    assert.equal(part.image_url.detail, "high");
  });

  it("falls back to low for an unrecognized value", () => {
    process.env.AZURE_OPENAI_VISION_DETAIL = "ultra";
    const part = imagePart(buildHexDetectionRequestPayload("https://img.example.com/a.jpg"));

    assert.equal(part.image_url.detail, "low");
  });
});

describe("lib/ai-color-detection — request errors keep the undici cause", () => {
  const { requestAzureOpenAIChatCompletion } = require("../dist/lib/ai-color-detection");
  const envKeys = ["AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_KEY", "AZURE_OPENAI_DEPLOYMENT"];
  let savedEnv;
  let savedFetch;

  beforeEach(() => {
    savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    savedFetch = global.fetch;
    process.env.AZURE_OPENAI_ENDPOINT = "https://openai.example.com";
    process.env.AZURE_OPENAI_KEY = "test-key";
    process.env.AZURE_OPENAI_DEPLOYMENT = "hex-detector";
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    global.fetch = savedFetch;
  });

  it("logs `TypeError: fetch failed (<code>: <message>)` for a connection-level failure", async () => {
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      if (calls === 1) {
        const cause = Object.assign(new Error("Connect Timeout Error"), { code: "UND_ERR_CONNECT_TIMEOUT" });
        throw new TypeError("fetch failed", { cause });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const logs = [];
    const result = await requestAzureOpenAIChatCompletion(
      { buildPayload: () => ({ messages: [] }), usageMetricPrefix: null },
      { onLog: (level, message, data) => logs.push({ level, message, data }) }
    );

    assert.equal(result.content, "ok");
    const retry = logs.find((entry) => entry.message.includes("Request error attempt 1/3"));
    assert.ok(retry, "the failed attempt is logged");
    assert.match(retry.message, /TypeError: fetch failed \(UND_ERR_CONNECT_TIMEOUT: Connect Timeout Error\), retrying in/);
    assert.equal(retry.data.error, "TypeError: fetch failed (UND_ERR_CONNECT_TIMEOUT: Connect Timeout Error)");
  });
});
