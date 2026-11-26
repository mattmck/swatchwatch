import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ingestionJobStatusLabel, pipelineStageOf, STORE_CLOSED_LABEL } from "./ingestion-job-status";

describe("ingestionJobStatusLabel", () => {
  it("names a succeeded store_closed job 'Store closed'", () => {
    assert.equal(ingestionJobStatusLabel({ status: "succeeded", stage: "store_closed" }), STORE_CLOSED_LABEL);
  });

  it("keeps the raw status for every other job", () => {
    assert.equal(ingestionJobStatusLabel({ status: "succeeded", stage: "completed" }), "succeeded");
    assert.equal(ingestionJobStatusLabel({ status: "failed", stage: "store_closed" }), "failed");
    assert.equal(ingestionJobStatusLabel({ status: "running" }), "running");
    assert.equal(ingestionJobStatusLabel({ status: "succeeded", stage: null }), "succeeded");
  });
});

describe("pipelineStageOf", () => {
  it("reads metrics.pipeline.stage", () => {
    assert.equal(pipelineStageOf({ pipeline: { stage: "store_closed" } }), "store_closed");
  });

  it("is null when the stage is missing or blank", () => {
    assert.equal(pipelineStageOf(undefined), null);
    assert.equal(pipelineStageOf({}), null);
    assert.equal(pipelineStageOf({ pipeline: { stage: " " } }), null);
    assert.equal(pipelineStageOf({ pipeline: "x" }), null);
  });
});
