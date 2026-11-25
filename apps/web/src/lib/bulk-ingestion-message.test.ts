import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bulkRunErrorMessage, bulkRunSuccessMessage } from "./bulk-ingestion-message";

class FakeApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
  }
}

describe("bulkRunSuccessMessage", () => {
  it("counts the queued jobs and lists skipped sources", () => {
    assert.equal(bulkRunSuccessMessage({ enqueued: 1 }), "1 job queued.");
    assert.equal(
      bulkRunSuccessMessage({ enqueued: 2, skipped: [{ source: "AShopify", reason: "already_running", jobId: "9" }] }),
      "2 jobs queued. Skipped (a job is already queued or running): AShopify."
    );
  });
});

describe("bulkRunErrorMessage", () => {
  it("shows the server's explanation for an all-busy run", () => {
    const error = new FakeApiError(409, "source_busy", {
      error: "source_busy",
      message: "Every source already has a job queued or running: AShopify, BShopify",
      skipped: [
        { source: "AShopify", reason: "already_running", jobId: "1" },
        { source: "BShopify", reason: "already_running", jobId: "2" },
      ],
    });
    assert.equal(bulkRunErrorMessage(error), "Every source already has a job queued or running: AShopify, BShopify");
  });

  it("adds the busy sources when the message does not name them", () => {
    const error = new FakeApiError(409, "source_busy", {
      error: "source_busy",
      skipped: [{ source: "AShopify", reason: "already_running", jobId: "1" }],
    });
    assert.equal(
      bulkRunErrorMessage(error),
      "Every selected source is busy. Skipped (a job is already queued or running): AShopify."
    );
  });

  it("keeps the error text for any other failure", () => {
    assert.equal(bulkRunErrorMessage(new FakeApiError(409, "source_blocked", { error: "source_blocked" })), "source_blocked");
    assert.equal(bulkRunErrorMessage(new Error("network")), "network");
    assert.equal(bulkRunErrorMessage("nope"), "Failed to queue bulk run");
  });
});
