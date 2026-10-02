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
