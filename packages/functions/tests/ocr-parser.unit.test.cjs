/**
 * Unit tests for lib/ocr-parser — parseLabelText()
 *
 * Stubs global.fetch and process.env to cover:
 * - Deployment name fallback order (LABEL → HEX → default)
 * - 429 single retry
 * - Non-OK response → null
 * - JSON field coercion (brand, shadeName, finish, gtin, sizeMl, confidence)
 * - JSON parse failure → bounded log (no full content dumped)
 * - Missing config → null (graceful degradation)
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const { parseLabelText } = require("../dist/lib/ocr-parser");

const OPENAI_ENV_VARS = [
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_OPENAI_KEY",
  "AZURE_OPENAI_DEPLOYMENT",
  "AZURE_OPENAI_DEPLOYMENT_HEX",
  "AZURE_OPENAI_DEPLOYMENT_LABEL",
  "AZURE_OPENAI_USE_GATEWAY",
  "AZURE_OPENAI_GATEWAY_ENDPOINT",
  "AZURE_OPENAI_GATEWAY_SUBSCRIPTION_KEY",
];

describe("lib/ocr-parser — parseLabelText", () => {
  let savedEnv;
  let savedFetch;

  beforeEach(() => {
    savedEnv = {};
    savedFetch = global.fetch;
    for (const key of OPENAI_ENV_VARS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of OPENAI_ENV_VARS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    global.fetch = savedFetch;
  });

  function makeOkResponse(fields = {}) {
    const body = {
      choices: [
        {
          message: {
            content: JSON.stringify({
              brand: "OPI",
              shadeName: "Big Apple Red",
              finish: "creme",
              collection: null,
              gtin: null,
              sizeMl: 15,
              confidence: 0.9,
              ...fields,
            }),
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 50 },
    };
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    };
  }

  function makeErrorResponse(status, bodyText = "error") {
    return {
      ok: false,
      status,
      headers: { get: () => null },
      json: () => Promise.reject(new Error("not json")),
      text: () => Promise.resolve(bodyText),
    };
  }

  // ---------------------------------------------------------------------------
  // No config → null
  // ---------------------------------------------------------------------------

  it("returns null when Azure OpenAI is not configured", async () => {
    const result = await parseLabelText("some OCR text");
    assert.equal(result, null);
  });

  // ---------------------------------------------------------------------------
  // Deployment fallback: LABEL → HEX → default
  // ---------------------------------------------------------------------------

  it("uses AZURE_OPENAI_DEPLOYMENT_LABEL when set", async () => {
    process.env.AZURE_OPENAI_ENDPOINT = "https://oai.example.com/";
    process.env.AZURE_OPENAI_KEY = "test-key";
    process.env.AZURE_OPENAI_DEPLOYMENT_LABEL = "label-deploy";
    process.env.AZURE_OPENAI_DEPLOYMENT_HEX = "hex-deploy";

    let capturedUrl = null;
    global.fetch = async (url) => {
      capturedUrl = url;
      return makeOkResponse();
    };

    const result = await parseLabelText("OPI Big Apple Red 15ml");
    assert.ok(result);
    assert.ok(capturedUrl.includes("label-deploy"), `expected label-deploy in URL, got: ${capturedUrl}`);
  });

  it("falls back to AZURE_OPENAI_DEPLOYMENT_HEX when LABEL is unset", async () => {
    process.env.AZURE_OPENAI_ENDPOINT = "https://oai.example.com/";
    process.env.AZURE_OPENAI_KEY = "test-key";
    process.env.AZURE_OPENAI_DEPLOYMENT_HEX = "hex-deploy";

    let capturedUrl = null;
    global.fetch = async (url) => {
      capturedUrl = url;
      return makeOkResponse();
    };

    await parseLabelText("OPI Big Apple Red 15ml");
    assert.ok(capturedUrl.includes("hex-deploy"), `expected hex-deploy in URL, got: ${capturedUrl}`);
  });

  it("falls back to AZURE_OPENAI_DEPLOYMENT when HEX and LABEL are unset", async () => {
    process.env.AZURE_OPENAI_ENDPOINT = "https://oai.example.com/";
    process.env.AZURE_OPENAI_KEY = "test-key";
    process.env.AZURE_OPENAI_DEPLOYMENT = "default-deploy";

    let capturedUrl = null;
    global.fetch = async (url) => {
      capturedUrl = url;
      return makeOkResponse();
    };

    await parseLabelText("OPI Big Apple Red 15ml");
    assert.ok(capturedUrl.includes("default-deploy"), `expected default-deploy in URL, got: ${capturedUrl}`);
  });

  // ---------------------------------------------------------------------------
  // 429 single retry
  // ---------------------------------------------------------------------------

  it("retries once on 429", async () => {
    process.env.AZURE_OPENAI_ENDPOINT = "https://oai.example.com/";
    process.env.AZURE_OPENAI_KEY = "test-key";
    process.env.AZURE_OPENAI_DEPLOYMENT_HEX = "hex-deploy";

    let callCount = 0;
    global.fetch = async () => {
      callCount++;
      if (callCount === 1) return makeErrorResponse(429);
      return makeOkResponse();
    };

    const result = await parseLabelText("OPI Big Apple Red");
    assert.ok(result);
    assert.equal(callCount, 2);
  });

  // ---------------------------------------------------------------------------
  // Non-OK response → null
  // ---------------------------------------------------------------------------

  it("returns null on non-OK response (500)", async () => {
    process.env.AZURE_OPENAI_ENDPOINT = "https://oai.example.com/";
    process.env.AZURE_OPENAI_KEY = "test-key";
    process.env.AZURE_OPENAI_DEPLOYMENT_HEX = "hex-deploy";

    global.fetch = async () => makeErrorResponse(500, "internal server error");

    const result = await parseLabelText("OPI Big Apple Red");
    assert.equal(result, null);
  });

  // ---------------------------------------------------------------------------
  // JSON field coercion
  // ---------------------------------------------------------------------------

  it("returns parsed fields with correct types", async () => {
    process.env.AZURE_OPENAI_ENDPOINT = "https://oai.example.com/";
    process.env.AZURE_OPENAI_KEY = "test-key";
    process.env.AZURE_OPENAI_DEPLOYMENT_HEX = "hex-deploy";

    global.fetch = async () =>
      makeOkResponse({
        brand: "Sally Hansen",
        shadeName: "Coral Reef",
        finish: "shimmer",
        collection: "Miracle Gel",
        gtin: "012345678901",
        sizeMl: "14.7",   // string → should coerce to number
        confidence: "0.85", // string → should coerce to number
      });

    const result = await parseLabelText("Sally Hansen Coral Reef 14.7ml");
    assert.ok(result);
    assert.equal(result.brand, "Sally Hansen");
    assert.equal(result.shadeName, "Coral Reef");
    assert.equal(result.finish, "shimmer");
    assert.equal(result.collection, "Miracle Gel");
    assert.equal(result.gtin, "012345678901");
    assert.equal(typeof result.sizeMl, "number");
    assert.ok(Math.abs(result.sizeMl - 14.7) < 0.001);
    assert.equal(typeof result.confidence, "number");
    assert.ok(Math.abs(result.confidence - 0.85) < 0.001);
  });

  it("returns null fields for non-string / empty field values", async () => {
    process.env.AZURE_OPENAI_ENDPOINT = "https://oai.example.com/";
    process.env.AZURE_OPENAI_KEY = "test-key";
    process.env.AZURE_OPENAI_DEPLOYMENT_HEX = "hex-deploy";

    global.fetch = async () =>
      makeOkResponse({
        brand: null,
        shadeName: "  ",   // whitespace-only → should become null
        finish: 42,        // wrong type → null
        sizeMl: -5,        // negative → null
        confidence: "not-a-number",
      });

    const result = await parseLabelText("OPI");
    assert.ok(result);
    assert.equal(result.brand, null);
    assert.equal(result.shadeName, null);
    assert.equal(result.finish, null);
    assert.equal(result.sizeMl, null);
    assert.equal(result.confidence, 0);
  });

  // ---------------------------------------------------------------------------
  // JSON parse failure → bounded log (no full content)
  // ---------------------------------------------------------------------------

  it("returns null and logs bounded summary (not full content) on LLM JSON parse failure", async () => {
    process.env.AZURE_OPENAI_ENDPOINT = "https://oai.example.com/";
    process.env.AZURE_OPENAI_KEY = "test-key";
    process.env.AZURE_OPENAI_DEPLOYMENT_HEX = "hex-deploy";

    const largeInvalidJson = "not valid json " + "X".repeat(2000);
    global.fetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: largeInvalidJson } }],
        }),
      text: () => Promise.resolve(""),
    });

    const errorLogs = [];
    const origError = console.error;
    console.error = (...args) => errorLogs.push(args.join(" "));
    try {
      const result = await parseLabelText("some text");
      assert.equal(result, null);
    } finally {
      console.error = origError;
    }

    const loggedText = errorLogs.join("\n");
    // Should log something about JSON parse failure
    assert.ok(loggedText.includes("Failed to parse LLM content"));
    // Should NOT dump the full large content verbatim
    assert.ok(!loggedText.includes("X".repeat(500)), "should not log full large content");
    // Should log a sha256prefix or len indicator
    assert.ok(loggedText.includes("len=") || loggedText.includes("sha256"), "should log bounded summary");
  });
});
