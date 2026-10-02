const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  parseVisionHexBatchOutput,
  parseVisionHexBatchDetections,
  getVisionHexBatchStatus,
  submitVisionHexBatch,
} = require("../dist/lib/azure-openai-batch");

// Builds a single successful Azure OpenAI batch output line (chat-completions shape).
function successLine(customId, content, usage) {
  return JSON.stringify({
    custom_id: customId,
    response: {
      status_code: 200,
      body: {
        choices: [{ message: { content } }],
        ...(usage ? { usage } : {}),
      },
    },
  });
}

describe("lib/azure-openai-batch — parseVisionHexBatchOutput", () => {
  it("maps custom_id to content, status code, and token usage", () => {
    const jsonl = [
      successLine('ext-1', '{"hex":"#aabbcc","confidence":0.9}', {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      }),
    ].join("\n");

    const rows = parseVisionHexBatchOutput(jsonl);

    assert.equal(rows.length, 1);
    assert.equal(rows[0].customId, "ext-1");
    assert.equal(rows[0].statusCode, 200);
    assert.equal(rows[0].content, '{"hex":"#aabbcc","confidence":0.9}');
    assert.equal(rows[0].error, null);
    assert.equal(rows[0].usage.totalTokens, 15);
  });

  it("skips malformed JSON, blank lines, and rows without a custom_id", () => {
    const jsonl = [
      "",
      "   ",
      "{ this is not json",
      JSON.stringify({ response: { status_code: 200, body: {} } }), // no custom_id
      successLine("ext-keep", '{"hex":"#112233"}'),
    ].join("\n");

    const rows = parseVisionHexBatchOutput(jsonl);

    assert.equal(rows.length, 1);
    assert.equal(rows[0].customId, "ext-keep");
  });

  it("captures error rows with null content and preserves the error message", () => {
    const jsonl = [
      successLine("ext-ok", '{"hex":"#00ff00"}'),
      JSON.stringify({
        custom_id: "ext-bad",
        response: { status_code: 500, body: {} },
        error: { message: "internal failure", code: "server_error" },
      }),
    ].join("\n");

    const rows = parseVisionHexBatchOutput(jsonl);

    assert.equal(rows.length, 2);
    const bad = rows.find((r) => r.customId === "ext-bad");
    assert.equal(bad.content, null);
    assert.equal(bad.statusCode, 500);
    assert.equal(bad.error, "internal failure");
  });

  it("returns an empty array for empty input", () => {
    assert.deepEqual(parseVisionHexBatchOutput(""), []);
  });
});

describe("lib/azure-openai-batch — parseVisionHexBatchDetections", () => {
  it("maps successful rows back to their custom_id with a parsed hex", async () => {
    const rows = parseVisionHexBatchOutput(
      successLine("ext-1", '{"hex":"#AABBCC","confidence":0.8}')
    );

    const detections = await parseVisionHexBatchDetections(rows);

    assert.equal(detections.length, 1);
    assert.equal(detections[0].customId, "ext-1");
    assert.equal(detections[0].detection.hex, "#AABBCC");
    assert.equal(detections[0].error, null);
  });

  it("handles a batch with partial failures: success keeps detection, failure surfaces error", async () => {
    const jsonl = [
      successLine("ext-good", '{"hex":"#123456","confidence":0.7}'),
      JSON.stringify({
        custom_id: "ext-fail",
        response: { status_code: 500, body: {} },
        error: { message: "boom" },
      }),
    ].join("\n");

    const detections = await parseVisionHexBatchDetections(
      parseVisionHexBatchOutput(jsonl)
    );

    const good = detections.find((d) => d.customId === "ext-good");
    const fail = detections.find((d) => d.customId === "ext-fail");

    assert.equal(good.detection.hex, "#123456");
    assert.equal(good.error, null);
    assert.equal(fail.detection, null);
    assert.equal(fail.error, "boom");
  });

  it("reports missing completion content as an error with no detection", async () => {
    const rows = parseVisionHexBatchOutput(
      JSON.stringify({
        custom_id: "ext-empty",
        response: { status_code: 200, body: { choices: [] } },
      })
    );

    const detections = await parseVisionHexBatchDetections(rows);

    assert.equal(detections.length, 1);
    assert.equal(detections[0].detection, null);
    assert.match(detections[0].error, /Missing completion content/);
  });
});

describe("lib/azure-openai-batch — submitVisionHexBatch JSONL generation", () => {
  const ENV_KEYS = [
    "AZURE_OPENAI_USE_GATEWAY",
    "AZURE_OPENAI_GATEWAY_ENDPOINT",
    "AZURE_OPENAI_GATEWAY_SUBSCRIPTION_KEY",
    "AZURE_OPENAI_ENDPOINT",
    "AZURE_OPENAI_KEY",
    "AZURE_OPENAI_DEPLOYMENT_HEX",
    "AZURE_OPENAI_DEPLOYMENT",
    "AZURE_OPENAI_DEPLOYMENT_HEX_BATCH",
  ];
  let savedEnv;
  let savedFetch;

  beforeEach(() => {
    savedEnv = {};
    savedFetch = global.fetch;
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.AZURE_OPENAI_ENDPOINT = "https://direct.openai.azure.com/";
    process.env.AZURE_OPENAI_KEY = "direct-api-key";
    process.env.AZURE_OPENAI_DEPLOYMENT_HEX = "gpt4o-deploy";
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    global.fetch = savedFetch;
  });

  it("uploads one JSONL line per request with the chat-completions request contract", async () => {
    let uploadedJsonl;
    let createBody;

    global.fetch = async (url, init) => {
      if (url.includes("/openai/files")) {
        const file = init.body.get("file");
        uploadedJsonl = await file.text();
        return {
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify({ id: "file-123" })),
        };
      }
      if (url.includes("/openai/batches")) {
        createBody = JSON.parse(init.body);
        return {
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify({ id: "batch-xyz" })),
        };
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    };

    const result = await submitVisionHexBatch([
      {
        customId: "ext-1",
        imageUrlOrDataUri: "https://img.example.com/a.jpg",
        vendorContext: { shadeName: "Mint Chip" },
      },
      {
        customId: "ext-2",
        imageUrlOrDataUri: "https://img.example.com/b.jpg",
      },
    ]);

    assert.deepEqual(
      { batchId: result.batchId, inputFileId: result.inputFileId, requestCount: result.requestCount },
      { batchId: "batch-xyz", inputFileId: "file-123", requestCount: 2 }
    );
    assert.equal(createBody.input_file_id, "file-123");
    assert.equal(createBody.endpoint, "/chat/completions");

    const lines = uploadedJsonl.split("\n").filter((line) => line.trim().length > 0);
    assert.equal(lines.length, 2);

    const first = JSON.parse(lines[0]);
    assert.equal(first.custom_id, "ext-1");
    assert.equal(first.method, "POST");
    assert.equal(first.url, "/chat/completions");
    assert.equal(first.body.model, "gpt4o-deploy");
    assert.ok(Array.isArray(first.body.messages));

    // The image reference is passed as a URL (not uploaded bytes).
    const userContent = first.body.messages[first.body.messages.length - 1].content;
    const imagePart = userContent.find((part) => part.type === "image_url");
    assert.equal(imagePart.image_url.url, "https://img.example.com/a.jpg");

    // Vendor context is included for the request that supplied it.
    const vendorPart = userContent.find(
      (part) => part.type === "text" && part.text.startsWith("Vendor context:")
    );
    assert.ok(vendorPart, "expected vendor context text part for ext-1");
    assert.match(vendorPart.text, /Mint Chip/);

    // The second request omitted vendor context.
    const second = JSON.parse(lines[1]);
    assert.equal(second.custom_id, "ext-2");
    const secondVendorPart = second.body.messages[
      second.body.messages.length - 1
    ].content.find((part) => part.type === "text" && part.text.startsWith("Vendor context:"));
    assert.equal(secondVendorPart, undefined);
  });
});

describe("lib/azure-openai-batch — getBatchConfig gateway/direct matrix", () => {
  // Saved env vars restored after each test to avoid cross-test pollution.
  let savedEnv;
  let savedFetch;

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
    "AZURE_OPENAI_BATCH_COMPLETION_WINDOW",
  ];

  beforeEach(() => {
    savedEnv = {};
    savedFetch = global.fetch;
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
    global.fetch = savedFetch;
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

  it("includes gateway toggle hint when required configuration is missing", async () => {
    await assert.rejects(
      () =>
        submitVisionHexBatch([
          {
            customId: "ext-999",
            imageUrlOrDataUri: "data:image/png;base64,AAAA",
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
