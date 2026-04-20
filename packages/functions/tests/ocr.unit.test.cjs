/**
 * Unit tests for lib/ocr — extractTextFromImage()
 *
 * Stubs global.fetch to cover:
 * - data URL vs HTTPS URL request body building
 * - Operation-Location polling loop
 * - Single 429 retry on submit
 * - Successful result parsing (text, lines, barcodes)
 * - Failed / timed-out analysis handling
 * - Missing credentials → graceful null
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const { extractTextFromImage } = require("../dist/lib/ocr");

const DI_ENV_VARS = [
  "AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT",
  "AZURE_DOCUMENT_INTELLIGENCE_KEY",
];

describe("lib/ocr — extractTextFromImage", () => {
  let savedEnv;
  let savedFetch;

  beforeEach(() => {
    savedEnv = {};
    savedFetch = global.fetch;
    for (const key of DI_ENV_VARS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of DI_ENV_VARS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    global.fetch = savedFetch;
  });

  function makeResponse(status, body, headers = {}) {
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (name) => headers[name.toLowerCase()] ?? null,
      },
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
    };
  }

  function pollSuccessBody(rawText = "OPI\nBig Apple Red") {
    return {
      status: "succeeded",
      analyzeResult: {
        content: rawText,
        pages: [
          {
            lines: [
              { content: "OPI", confidence: 0.99, polygon: [0, 0, 10, 0, 10, 5, 0, 5] },
              { content: "Big Apple Red", confidence: 0.97 },
            ],
            barcodes: [
              { value: "012345678901", kind: "EAN_13", confidence: 0.95 },
            ],
          },
        ],
      },
    };
  }

  // ---------------------------------------------------------------------------
  // No credentials
  // ---------------------------------------------------------------------------

  it("returns null when credentials are not configured", async () => {
    const result = await extractTextFromImage("https://example.com/img.png");
    assert.equal(result, null);
  });

  // ---------------------------------------------------------------------------
  // HTTPS URL — request body uses urlSource
  // ---------------------------------------------------------------------------

  it("sends urlSource in request body for HTTPS URLs", async () => {
    process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT = "https://docint.example.com/";
    process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY = "test-key";

    const fetchCalls = [];
    global.fetch = async (url, init) => {
      fetchCalls.push({ url, body: init?.body ? JSON.parse(init.body) : null, headers: init?.headers });

      if (fetchCalls.length === 1) {
        // Submit
        return makeResponse(202, "", {
          "operation-location": "https://docint.example.com/operations/abc123",
        });
      }
      // Poll
      return makeResponse(200, pollSuccessBody());
    };

    const result = await extractTextFromImage("https://blob.example/frame.png");

    assert.ok(result);
    const submitCall = fetchCalls[0];
    assert.equal(submitCall.body.urlSource, "https://blob.example/frame.png");
    assert.equal(submitCall.body.base64Source, undefined);
  });

  // ---------------------------------------------------------------------------
  // Data URL — request body uses base64Source (prefix stripped)
  // ---------------------------------------------------------------------------

  it("sends base64Source (without data URI prefix) for data URLs", async () => {
    process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT = "https://docint.example.com/";
    process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY = "test-key";

    const fetchCalls = [];
    global.fetch = async (url, init) => {
      fetchCalls.push({ url, body: init?.body ? JSON.parse(init.body) : null });

      if (fetchCalls.length === 1) {
        return makeResponse(202, "", {
          "operation-location": "https://docint.example.com/operations/def456",
        });
      }
      return makeResponse(200, pollSuccessBody());
    };

    const result = await extractTextFromImage("data:image/png;base64,YWJjZGVm");

    assert.ok(result);
    const submitBody = fetchCalls[0].body;
    assert.equal(submitBody.base64Source, "YWJjZGVm");
    assert.equal(submitBody.urlSource, undefined);
  });

  // ---------------------------------------------------------------------------
  // Successful result parsing — lines, barcodes, average confidence
  // ---------------------------------------------------------------------------

  it("parses lines, barcodes, and averages confidence from a successful response", async () => {
    process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT = "https://docint.example.com/";
    process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY = "test-key";

    let callCount = 0;
    global.fetch = async () => {
      callCount++;
      if (callCount === 1) {
        return makeResponse(202, "", {
          "operation-location": "https://docint.example.com/operations/ghi789",
        });
      }
      return makeResponse(200, pollSuccessBody("OPI\nBig Apple Red"));
    };

    const result = await extractTextFromImage("https://example.com/img.png");

    assert.ok(result);
    assert.equal(result.rawText, "OPI\nBig Apple Red");
    assert.equal(result.lines.length, 2);
    assert.equal(result.lines[0].text, "OPI");
    assert.ok(result.lines[0].confidence > 0.9);
    assert.equal(result.barcodes.length, 1);
    assert.equal(result.barcodes[0].value, "012345678901");
    assert.equal(result.barcodes[0].kind, "EAN_13");
    assert.ok(result.confidence > 0);
    assert.equal(result.provider, "azure-document-intelligence");
  });

  // ---------------------------------------------------------------------------
  // 429 retry on submit
  // ---------------------------------------------------------------------------

  it("retries once on 429 from the submit endpoint", async () => {
    process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT = "https://docint.example.com/";
    process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY = "test-key";

    let callCount = 0;
    global.fetch = async () => {
      callCount++;
      if (callCount === 1) {
        return makeResponse(429, "rate limited");
      }
      if (callCount === 2) {
        return makeResponse(202, "", {
          "operation-location": "https://docint.example.com/operations/jkl000",
        });
      }
      // Poll
      return makeResponse(200, pollSuccessBody());
    };

    const result = await extractTextFromImage("https://example.com/img.png");

    assert.ok(result);
    // first call = 429, second call = 202 (retry), third+ = poll
    assert.ok(callCount >= 3, `expected at least 3 fetch calls, got ${callCount}`);
  });

  // ---------------------------------------------------------------------------
  // Non-OK submit response → null
  // ---------------------------------------------------------------------------

  it("returns null on non-OK submit response", async () => {
    process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT = "https://docint.example.com/";
    process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY = "test-key";

    global.fetch = async () => makeResponse(400, "bad request");

    const result = await extractTextFromImage("https://example.com/img.png");
    assert.equal(result, null);
  });

  // ---------------------------------------------------------------------------
  // Missing Operation-Location header → null
  // ---------------------------------------------------------------------------

  it("returns null when Operation-Location header is missing", async () => {
    process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT = "https://docint.example.com/";
    process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY = "test-key";

    global.fetch = async () => makeResponse(202, "");

    const result = await extractTextFromImage("https://example.com/img.png");
    assert.equal(result, null);
  });

  // ---------------------------------------------------------------------------
  // Polling: failed analysis status → sanitized log + null
  // ---------------------------------------------------------------------------

  it("returns null when analysis status is 'failed' (sanitized log, not full body)", async () => {
    process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT = "https://docint.example.com/";
    process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY = "test-key";

    let callCount = 0;
    global.fetch = async () => {
      callCount++;
      if (callCount === 1) {
        return makeResponse(202, "", {
          "operation-location": "https://docint.example.com/operations/failed01",
        });
      }
      return makeResponse(200, {
        status: "failed",
        error: { code: "InvalidRequest", message: "Could not process document" },
        // Large payload that should NOT be logged verbatim
        analyzeResult: { content: "A".repeat(10000) },
      });
    };

    const errorLogs = [];
    const origError = console.error;
    console.error = (...args) => errorLogs.push(args.join(" "));
    try {
      const result = await extractTextFromImage("https://example.com/img.png");
      assert.equal(result, null);
    } finally {
      console.error = origError;
    }

    // Should log error code/message, NOT the full analyzeResult content
    assert.ok(errorLogs.some((msg) => msg.includes("InvalidRequest")));
    assert.ok(errorLogs.some((msg) => msg.includes("Could not process document")));
    // Use a long substring (500 chars) so the assertion fails meaningfully if
    // the implementation accidentally dumps large portions of the response body
    assert.ok(!errorLogs.some((msg) => msg.includes("A".repeat(500))),
      "log should not contain large raw content");
  });

  // ---------------------------------------------------------------------------
  // Polling: continues on 'running' status until 'succeeded'
  // ---------------------------------------------------------------------------

  it("polls multiple times through 'running' statuses before succeeding", async () => {
    process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT = "https://docint.example.com/";
    process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY = "test-key";

    let callCount = 0;
    global.fetch = async () => {
      callCount++;
      if (callCount === 1) {
        return makeResponse(202, "", {
          "operation-location": "https://docint.example.com/operations/slow01",
        });
      }
      if (callCount <= 3) {
        return makeResponse(200, { status: "running" });
      }
      return makeResponse(200, pollSuccessBody("OPI"));
    };

    const result = await extractTextFromImage("https://example.com/img.png");

    assert.ok(result, "should eventually succeed");
    assert.equal(result.rawText, "OPI");
    assert.ok(callCount >= 4, `expected >= 4 calls, got ${callCount}`);
  });
});
