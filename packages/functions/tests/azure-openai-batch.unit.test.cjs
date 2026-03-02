const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { parseVisionHexBatchOutput } = require("../dist/lib/azure-openai-batch");

describe("lib/azure-openai-batch — parseVisionHexBatchOutput", () => {
  it("parses successful output lines", () => {
    const jsonl = [
      JSON.stringify({
        custom_id: "ext-123",
        response: {
          status_code: 200,
          body: {
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
  });
});
