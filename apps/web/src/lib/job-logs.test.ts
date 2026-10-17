import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { IngestionLogEntry } from "swatchwatch-shared";
import {
  filterJobLog,
  formatJobLogCount,
  getJobLogs,
  isOmissionMarker,
  summarizeJobLog,
} from "./job-logs";

const line = (msg: string, level: IngestionLogEntry["level"] = "info"): IngestionLogEntry => ({
  ts: "2026-10-14T00:00:00.000Z",
  level,
  msg,
});

const marker: IngestionLogEntry = {
  ts: "2026-10-14T00:05:00.000Z",
  level: "info",
  msg: "… 1,200 earlier log lines omitted …",
  omitted: { count: 1200, byLevel: { info: 1195, warn: 4, error: 1 } },
};

describe("job log helpers", () => {
  it("reads only well-formed entries from job metrics", () => {
    const logs = getJobLogs({
      metrics: { logs: [line("ok"), { ts: 1, level: "info", msg: "bad" }, null, line("loud", "warn")] },
    });
    assert.deepEqual(logs.map((entry) => entry.msg), ["ok", "loud"]);
    assert.deepEqual(getJobLogs({ metrics: undefined }), []);
    assert.deepEqual(getJobLogs({ metrics: { logs: "nope" } }), []);
  });

  it("counts the whole run, including lines rolled up in the omission marker", () => {
    const summary = summarizeJobLog([line("start"), marker, line("warned", "warn"), line("failed", "error")]);
    assert.deepEqual(summary, { shown: 3, total: 1203, omitted: 1200, errors: 2, warnings: 5 });
    assert.equal(formatJobLogCount(summary), "3 of 1,203 lines");
  });

  it("labels an untrimmed log by entry count", () => {
    assert.equal(formatJobLogCount(summarizeJobLog([line("a"), line("b")])), "2 entries");
    assert.equal(formatJobLogCount(summarizeJobLog([line("a")])), "1 entry");
  });

  it("filters to warnings, errors and the omission marker", () => {
    const logs = [line("start"), marker, line("warned", "warn"), line("done")];
    assert.deepEqual(filterJobLog(logs, "problems").map((entry) => entry.msg), [marker.msg, "warned"]);
    assert.equal(filterJobLog(logs, "all").length, 4);
    assert.equal(isOmissionMarker(marker), true);
    assert.equal(isOmissionMarker(line("plain")), false);
  });
});
