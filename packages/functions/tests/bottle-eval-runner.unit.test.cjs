const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const { runSample, parseArgs } = require("../dist/eval/bottle/cli");
const { createCaptureApi, assertApiReachable, EvalConfigError } = require("../dist/eval/bottle/api-client");
const { toEvalSamples } = require("../dist/eval/bottle/samples");
const { formatSummary } = require("../dist/eval/bottle/report");
const { summarize } = require("../dist/eval/bottle/scoring");

function fakeApi(checkResponse, { failOn } = {}) {
  const calls = [];
  return {
    calls,
    baseUrl: "http://fake/api",
    async start(meta) {
      calls.push(["start", meta]);
      if (failOn === "start") throw new Error("POST start → 500");
      return "capture-1";
    },
    async frame(id, body) {
      calls.push(["frame", id, body]);
      if (failOn === "frame") throw new Error("POST frame → 500");
    },
    async check(id) {
      calls.push(["check", id]);
      return checkResponse;
    },
  };
}

function sample(overrides = {}) {
  return {
    sampleId: 5,
    shadeId: 42,
    brand: "Holo Taco",
    shadeName: "Rainbow Bridge",
    frames: [
      { frameId: 2, surface: "front", frameType: "label", storageUrl: "blob://front" },
      { frameId: 3, surface: "glass", frameType: "color", storageUrl: "blob://glass" },
    ],
    ...overrides,
  };
}

const MATCH = {
  entityType: "shade",
  entityId: "42",
  shadeId: "42",
  display: "Holo Taco Rainbow Bridge",
  confidence: 0.95,
  ownership: { relationship: "notOwned" },
};

describe("runSample", () => {
  it("skips a sample without frames and makes no API call", async () => {
    const api = fakeApi({});
    const result = await runSample(api, sample({ frames: [] }), async () => assert.fail("no blob read"));
    assert.equal(result.outcome, "skipped_no_frames");
    assert.equal(result.frames, 0);
    assert.deepEqual(api.calls, []);
  });

  it("starts with eval metadata, sends frames in order as data URLs, then only checks", async () => {
    const api = fakeApi({ status: "processing", outcome: "matched", confidence: 0.95, match: MATCH, candidates: [MATCH] });
    const result = await runSample(api, sample(), async (url) => `data:image/jpeg;base64,${Buffer.from(url).toString("base64")}`);
    assert.deepEqual(api.calls.map((call) => call[0]), ["start", "frame", "frame", "check"]);
    assert.deepEqual(api.calls[0][1], { source: "bottle-eval", sampleId: 5 });
    assert.deepEqual(api.calls[1][2], {
      imageBlobUrl: `data:image/jpeg;base64,${Buffer.from("blob://front").toString("base64")}`,
      frameType: "label",
      quality: { surface: "front" },
    });
    assert.equal(api.calls[2][2].frameType, "color");
    assert.deepEqual(api.calls[2][2].quality, { surface: "glass" });
    assert.equal(result.outcome, "matched_correct");
    assert.equal(result.status, "matched");
    assert.equal(result.topEntityId, 42);
    assert.deepEqual(result.candidateIds, [42]);
    assert.equal(result.frames, 2);
    assert.equal(result.inCatalog, true);
  });

  it("records an API or blob failure as error and keeps going", async () => {
    const apiFailure = await runSample(fakeApi({}, { failOn: "frame" }), sample(), async () => "data:image/jpeg;base64,AA==");
    assert.equal(apiFailure.outcome, "error");
    assert.match(apiFailure.error, /500/);

    const blobFailure = await runSample(fakeApi({}), sample(), async () => {
      throw new Error("Blob read failed: 404");
    });
    assert.equal(blobFailure.outcome, "error");
    assert.equal(blobFailure.frames, 0);
    assert.match(blobFailure.error, /Blob read failed/);
  });
});

describe("createCaptureApi / assertApiReachable", () => {
  it("throws EvalConfigError for an empty base URL or token", () => {
    assert.throws(() => createCaptureApi("", "dev:2"), EvalConfigError);
    assert.throws(() => createCaptureApi("http://localhost:7071/api", ""), EvalConfigError);
    assert.throws(() => createCaptureApi("http://localhost:7071/api", "  "), EvalConfigError);
  });

  it("names the URL when the API is unreachable", async () => {
    const server = http.createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    await new Promise((resolve) => server.close(resolve));
    const api = createCaptureApi(`http://127.0.0.1:${port}/api/`, "dev:2");
    await assert.rejects(assertApiReachable(api), (error) => {
      assert.ok(error instanceof EvalConfigError);
      assert.ok(error.message.includes(`http://127.0.0.1:${port}/api/reference/finishes`));
      return true;
    });
  });

  it("accepts a 200 from reference/finishes and rejects other statuses", async () => {
    let status = 200;
    const seen = [];
    const server = http.createServer((req, res) => {
      seen.push(req.url);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end("[]");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const api = createCaptureApi(`http://127.0.0.1:${server.address().port}/api`, "dev:2");
      await assertApiReachable(api);
      status = 503;
      await assert.rejects(assertApiReachable(api), /HTTP 503/);
      assert.deepEqual(seen, ["/api/reference/finishes", "/api/reference/finishes"]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("toEvalSamples", () => {
  it("groups frames by sample in the given order and maps ids to numbers", () => {
    const samples = toEvalSamples(
      [
        { sampleId: "9", shadeId: null, brand: "Indie", shadeName: "Mystery", notes: null, createdByUserId: "2", createdAt: new Date() },
        { sampleId: "8", shadeId: "42", brand: "Holo Taco", shadeName: "Rainbow Bridge", notes: null, createdByUserId: "2", createdAt: new Date() },
      ],
      [
        { frameId: "11", sampleId: "8", surface: "front", frameType: "label", storageUrl: "u1", ownerId: "2" },
        { frameId: "10", sampleId: "8", surface: "glass", frameType: "color", storageUrl: "u2", ownerId: "2" },
      ]
    );
    assert.deepEqual(samples.map((s) => [s.sampleId, s.shadeId, s.frames.length]), [[9, null, 0], [8, 42, 2]]);
    assert.deepEqual(samples[1].frames.map((f) => f.frameId), [11, 10]);
  });
});

describe("parseArgs and formatSummary", () => {
  it("parses the flags and rejects unknown ones", () => {
    const args = parseArgs(["--limit", "3", "--only", "holo", "--verbose"]);
    assert.equal(args.limit, 3);
    assert.equal(args.only, "holo");
    assert.equal(args.verbose, true);
    assert.throws(() => parseArgs(["--limit", "0"]), /positive integer/);
    assert.throws(() => parseArgs(["--strategy", "x"]), /Unknown argument/);
  });

  it("prints rates, per-brand rows and the per-sample table when verbose", () => {
    const results = [
      { sampleId: 1, brand: "Holo Taco", shadeName: "A", inCatalog: true, outcome: "matched_correct", status: "matched", topEntityId: 42, candidateIds: [42], frames: 2, ms: 120 },
    ];
    const text = formatSummary(summarize(results), results, true);
    assert.match(text, /Match rate:\s+100\.0%/);
    assert.match(text, /Holo Taco/);
    assert.match(text, /matched_correct/);
    assert.ok(!formatSummary(summarize(results), results, false).includes("candidates"));
  });
});
