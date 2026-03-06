const { beforeEach, afterEach, describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  parseVisionHexBatchOutput,
  submitVisionHexBatch,
} = require("../dist/lib/azure-openai-batch");

const GATEWAY_VARS = [
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_OPENAI_KEY",
  "AZURE_OPENAI_GATEWAY_ENDPOINT",
  "AZURE_OPENAI_GATEWAY_SUBSCRIPTION_KEY",
  "AZURE_OPENAI_USE_GATEWAY",
  "AZURE_OPENAI_DEPLOYMENT_HEX_BATCH",
  "AZURE_OPENAI_DEPLOYMENT_HEX",
  "AZURE_OPENAI_DEPLOYMENT",
  "AZURE_OPENAI_BATCH_API_VERSION",
  "AZURE_OPENAI_BATCH_COMPLETION_WINDOW",
];

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
  let savedEnv;
  let savedFetch;

  beforeEach(() => {
    savedEnv = { ...process.env };
    savedFetch = global.fetch;
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
    global.fetch = savedFetch;
  });

  it("falls back to direct mode when gateway is enabled but missing gateway prerequisites", async () => {
    for (const key of GATEWAY_VARS) {
      delete process.env[key];
    }
    process.env.AZURE_OPENAI_USE_GATEWAY = "true";
    process.env.AZURE_OPENAI_ENDPOINT = "https://direct.openai.azure.com/";
    process.env.AZURE_OPENAI_KEY = "direct-key";
    process.env.AZURE_OPENAI_DEPLOYMENT_HEX_BATCH = "hex-detector-batch";

    const urls = [];
    const headers = [];
    let callCount = 0;
    global.fetch = async (url, init = {}) => {
      urls.push(String(url));
      headers.push(init.headers || {});
      callCount += 1;
      if (callCount === 1) {
        return new Response(JSON.stringify({ id: "file-123" }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: "batch-456" }), { status: 200 });
    };

    const result = await submitVisionHexBatch([
      {
        customId: "ext-1",
        imageUrlOrDataUri: "data:image/png;base64,AAAA",
      },
    ]);

    assert.equal(result.inputFileId, "file-123");
    assert.equal(result.batchId, "batch-456");
    assert.equal(callCount, 2);
    assert.match(urls[0], /^https:\/\/direct\.openai\.azure\.com\/openai\/files\?/);
    assert.equal(headers[0]["api-key"], "direct-key");
  });

  it("includes the gateway toggle hint when batch configuration is incomplete", async () => {
    for (const key of GATEWAY_VARS) {
      delete process.env[key];
    }

    await assert.rejects(
      () =>
        submitVisionHexBatch([
          {
            customId: "ext-2",
            imageUrlOrDataUri: "data:image/png;base64,BBBB",
          },
        ]),
      (error) => {
        assert.match(
          error.message,
          /AZURE_OPENAI_USE_GATEWAY=true with AZURE_OPENAI_GATEWAY_ENDPOINT and AZURE_OPENAI_GATEWAY_SUBSCRIPTION_KEY/
        );
        return true;
      }
    );
  });
});
