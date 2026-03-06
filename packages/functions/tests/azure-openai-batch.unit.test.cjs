const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const { parseVisionHexBatchOutput, getVisionHexBatchStatus } = require("../dist/lib/azure-openai-batch");

describe("lib/azure-openai-batch — parseVisionHexBatchOutput", () => {
  it("parses successful output lines", () => {
    const jsonl = [
      JSON.stringify({
        custom_id: "ext-123",
        response: {
          status_code: 200,
          body: {
            usage: {
              prompt_tokens: 456,
              completion_tokens: 32,
              total_tokens: 488,
            },
            choices: [
              {
                message: {
                  content: '{"hex":"#FF00AA","confidence":0.91,"finishes":["shimmer"]}',
                },
              },
            ],
          },
        },
      }),
    ].join("\n");

    const parsed = parseVisionHexBatchOutput(jsonl);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].customId, "ext-123");
    assert.equal(parsed[0].statusCode, 200);
    assert.equal(
      parsed[0].content,
      '{"hex":"#FF00AA","confidence":0.91,"finishes":["shimmer"]}'
    );
    assert.equal(parsed[0].error, null);
    assert.deepEqual(parsed[0].usage, {
      promptTokens: 456,
      completionTokens: 32,
      totalTokens: 488,
    });
  });

  it("captures per-line errors", () => {
    const jsonl = [
      JSON.stringify({
        custom_id: "ext-456",
        response: {
          status_code: 400,
          body: {
            error: {
              code: "content_filter",
              message: "Request blocked by policy",
            },
          },
        },
        error: {
          message: "Batch request failed",
        },
      }),
    ].join("\n");

    const parsed = parseVisionHexBatchOutput(jsonl);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].customId, "ext-456");
    assert.equal(parsed[0].statusCode, 400);
    assert.equal(parsed[0].content, null);
    assert.equal(parsed[0].error, "Batch request failed");
    assert.equal(parsed[0].usage, null);
  });
});

describe("lib/azure-openai-batch — getBatchConfig gateway/direct matrix", () => {
  // Saved env vars restored after each test to avoid cross-test pollution.
  let savedEnv;

  const GATEWAY_VARS = [
    "AZURE_OPENAI_USE_GATEWAY",
    "AZURE_OPENAI_GATEWAY_ENDPOINT",
    "AZURE_OPENAI_GATEWAY_SUBSCRIPTION_KEY",
    "AZURE_OPENAI_ENDPOINT",
    "AZURE_OPENAI_KEY",
    "AZURE_OPENAI_DEPLOYMENT_HEX",
    "AZURE_OPENAI_DEPLOYMENT",
    "AZURE_OPENAI_DEPLOYMENT_HEX_BATCH",
    "AZURE_OPENAI_BATCH_API_VERSION",
  ];

  beforeEach(() => {
    savedEnv = {};
    for (const key of GATEWAY_VARS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of GATEWAY_VARS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  function makeOkResponse(body) {
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(body)),
    });
  }

  it("direct-only: uses directEndpoint and api-key header", async () => {
    process.env.AZURE_OPENAI_ENDPOINT = "https://direct.openai.azure.com/";
    process.env.AZURE_OPENAI_KEY = "direct-api-key";
    process.env.AZURE_OPENAI_DEPLOYMENT_HEX = "gpt4o-deploy";

    let capturedUrl;
    let capturedHeaders;
    global.fetch = async (url, init) => {
      capturedUrl = url;
      capturedHeaders = init?.headers ?? {};
      return makeOkResponse({ id: "batch-001", status: "completed", request_counts: null });
    };

    await getVisionHexBatchStatus("batch-001");

    assert.ok(capturedUrl.startsWith("https://direct.openai.azure.com"), `Expected direct endpoint, got: ${capturedUrl}`);
    assert.equal(capturedHeaders["api-key"], "direct-api-key");
    assert.equal(capturedHeaders["Ocp-Apim-Subscription-Key"], undefined);
  });

  it("gateway fully configured: uses gatewayEndpoint and Ocp-Apim-Subscription-Key header", async () => {
    process.env.AZURE_OPENAI_USE_GATEWAY = "true";
    process.env.AZURE_OPENAI_GATEWAY_ENDPOINT = "https://apim.example.com/";
    process.env.AZURE_OPENAI_GATEWAY_SUBSCRIPTION_KEY = "apim-sub-key";
    process.env.AZURE_OPENAI_ENDPOINT = "https://direct.openai.azure.com/";
    process.env.AZURE_OPENAI_KEY = "direct-api-key";
    process.env.AZURE_OPENAI_DEPLOYMENT_HEX = "gpt4o-deploy";

    let capturedUrl;
    let capturedHeaders;
    global.fetch = async (url, init) => {
      capturedUrl = url;
      capturedHeaders = init?.headers ?? {};
      return makeOkResponse({ id: "batch-001", status: "completed", request_counts: null });
    };

    await getVisionHexBatchStatus("batch-001");

    assert.ok(capturedUrl.startsWith("https://apim.example.com"), `Expected gateway endpoint, got: ${capturedUrl}`);
    assert.equal(capturedHeaders["Ocp-Apim-Subscription-Key"], "apim-sub-key");
    assert.equal(capturedHeaders["api-key"], undefined);
  });

  it("USE_GATEWAY=true but missing gateway vars: falls back to directEndpoint and api-key header", async () => {
    // Flag is true but gateway endpoint and subscription key are absent —
    // effectiveUseGateway must be false, preventing the auth-header mismatch.
    process.env.AZURE_OPENAI_USE_GATEWAY = "true";
    process.env.AZURE_OPENAI_ENDPOINT = "https://direct.openai.azure.com/";
    process.env.AZURE_OPENAI_KEY = "direct-api-key";
    process.env.AZURE_OPENAI_DEPLOYMENT_HEX = "gpt4o-deploy";

    let capturedUrl;
    let capturedHeaders;
    global.fetch = async (url, init) => {
      capturedUrl = url;
      capturedHeaders = init?.headers ?? {};
      return makeOkResponse({ id: "batch-001", status: "completed", request_counts: null });
    };

    await getVisionHexBatchStatus("batch-001");

    assert.ok(capturedUrl.startsWith("https://direct.openai.azure.com"), `Expected direct endpoint fallback, got: ${capturedUrl}`);
    assert.equal(capturedHeaders["api-key"], "direct-api-key");
    assert.equal(capturedHeaders["Ocp-Apim-Subscription-Key"], undefined);
  });
});
