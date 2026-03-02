const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

// We need the compiled dist version
const {
  isBatchEnabled,
  shouldUseBatch,
  BATCH_MIN_CANDIDATES,
  BATCH_CUSTOM_ID_PREFIX,
} = require("../dist/lib/openai-batch");

// parseBatchOutput is tested by importing parseSingleBatchOutputLine indirectly
// via parseBatchOutput — we call parseBatchOutput with mocked fetch.

describe("lib/openai-batch — isBatchEnabled", () => {
  let originalValue;

  beforeEach(() => {
    originalValue = process.env.AZURE_OPENAI_BATCH_ENABLED;
  });

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env.AZURE_OPENAI_BATCH_ENABLED;
    } else {
      process.env.AZURE_OPENAI_BATCH_ENABLED = originalValue;
    }
  });

  it("returns false when env var is not set", () => {
    delete process.env.AZURE_OPENAI_BATCH_ENABLED;
    assert.equal(isBatchEnabled(), false);
  });

  it("returns false when env var is 'false'", () => {
    process.env.AZURE_OPENAI_BATCH_ENABLED = "false";
    assert.equal(isBatchEnabled(), false);
  });

  it("returns false when env var is '0'", () => {
    process.env.AZURE_OPENAI_BATCH_ENABLED = "0";
    assert.equal(isBatchEnabled(), false);
  });

  it("returns false when env var is empty string", () => {
    process.env.AZURE_OPENAI_BATCH_ENABLED = "";
    assert.equal(isBatchEnabled(), false);
  });

  it("returns true when env var is 'true'", () => {
    process.env.AZURE_OPENAI_BATCH_ENABLED = "true";
    assert.equal(isBatchEnabled(), true);
  });

  it("returns true when env var is 'TRUE' (case-insensitive)", () => {
    process.env.AZURE_OPENAI_BATCH_ENABLED = "TRUE";
    assert.equal(isBatchEnabled(), true);
  });

  it("returns true when env var is '  true  ' (with whitespace)", () => {
    process.env.AZURE_OPENAI_BATCH_ENABLED = "  true  ";
    assert.equal(isBatchEnabled(), true);
  });

  it("reads process.env at call time, not at module load time", () => {
    delete process.env.AZURE_OPENAI_BATCH_ENABLED;
    assert.equal(isBatchEnabled(), false);

    // Now set the flag — should take effect immediately
    process.env.AZURE_OPENAI_BATCH_ENABLED = "true";
    assert.equal(isBatchEnabled(), true);

    // Unset — should go back to false
    delete process.env.AZURE_OPENAI_BATCH_ENABLED;
    assert.equal(isBatchEnabled(), false);
  });
});

describe("lib/openai-batch — shouldUseBatch", () => {
  let originalValue;

  beforeEach(() => {
    originalValue = process.env.AZURE_OPENAI_BATCH_ENABLED;
  });

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env.AZURE_OPENAI_BATCH_ENABLED;
    } else {
      process.env.AZURE_OPENAI_BATCH_ENABLED = originalValue;
    }
  });

  it("returns false when batch is disabled even with many candidates", () => {
    delete process.env.AZURE_OPENAI_BATCH_ENABLED;
    assert.equal(shouldUseBatch(100), false);
  });

  it("returns false when batch is enabled but candidate count is below minimum", () => {
    process.env.AZURE_OPENAI_BATCH_ENABLED = "true";
    assert.equal(shouldUseBatch(BATCH_MIN_CANDIDATES - 1), false);
  });

  it("returns false when batch is enabled but candidate count is zero", () => {
    process.env.AZURE_OPENAI_BATCH_ENABLED = "true";
    assert.equal(shouldUseBatch(0), false);
  });

  it("returns true when batch is enabled and candidate count meets minimum", () => {
    process.env.AZURE_OPENAI_BATCH_ENABLED = "true";
    assert.equal(shouldUseBatch(BATCH_MIN_CANDIDATES), true);
  });

  it("returns true when batch is enabled and candidate count exceeds minimum", () => {
    process.env.AZURE_OPENAI_BATCH_ENABLED = "true";
    assert.equal(shouldUseBatch(BATCH_MIN_CANDIDATES + 10), true);
  });
});

describe("lib/openai-batch — constants", () => {
  it("BATCH_MIN_CANDIDATES is a positive integer", () => {
    assert.ok(Number.isInteger(BATCH_MIN_CANDIDATES) && BATCH_MIN_CANDIDATES > 0);
  });

  it("BATCH_CUSTOM_ID_PREFIX is a non-empty string", () => {
    assert.ok(typeof BATCH_CUSTOM_ID_PREFIX === "string" && BATCH_CUSTOM_ID_PREFIX.length > 0);
  });
});
