/** #548: a full Postgres server (SQLSTATE 53300) is a retryable connection error. */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { isRetryableConnectionError } = require("../dist/lib/db");

describe("isRetryableConnectionError", () => {
  it("retries when the server has no connection slots left", () => {
    assert.equal(
      isRetryableConnectionError(
        new Error("remaining connection slots are reserved for roles with the SUPERUSER attribute")
      ),
      true
    );
    assert.equal(isRetryableConnectionError(new Error("sorry, too many clients already")), true);
    assert.equal(
      isRetryableConnectionError(Object.assign(new Error("any wording"), { code: "53300" })),
      true
    );
  });

  it("still retries connection timeouts", () => {
    assert.equal(
      isRetryableConnectionError(new Error("Connection terminated due to connection timeout")),
      true
    );
  });

  it("does not retry query errors or non-errors", () => {
    assert.equal(
      isRetryableConnectionError(Object.assign(new Error("duplicate key value"), { code: "23505" })),
      false
    );
    assert.equal(isRetryableConnectionError("remaining connection slots are reserved"), false);
  });
});
