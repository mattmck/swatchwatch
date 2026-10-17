const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  aggregateHexSamples,
  agreementForSpread,
  majorityFinishes,
  tallyFinishVotes,
  ENSEMBLE_SPREAD_ZERO_AGREEMENT,
} = require("../dist/lib/hex-ensemble");
const { MEDIUM_CONFIDENCE_MAX_DISTANCE } = require("../dist/lib/color-match");
const { buildHexDetectionRequestPayload } = require("../dist/lib/ai-color-detection");
const { hexToOklab, oklabDistance } = require("swatchwatch-shared");

describe("lib/hex-ensemble — aggregateHexSamples", () => {
  it("picks the medoid and ignores a single outlier", () => {
    // Three near-identical reds and one green outlier: the medoid must be a red, never the green.
    const samples = [
      { hex: "#C0392B", confidence: 0.9 },
      { hex: "#2ECC71", confidence: 0.9 }, // outlier
      { hex: "#C23A2C", confidence: 0.8 },
      { hex: "#BF3828", confidence: 0.85 },
    ];
    const result = aggregateHexSamples(samples);

    assert.notEqual(result.medoidIndex, 1);
    assert.ok(["#C0392B", "#C23A2C", "#BF3828"].includes(result.hex));
    assert.equal(result.validCount, 4);
    assert.equal(result.distances[result.medoidIndex], 0);
    // The outlier is far from the medoid, the reds are close.
    assert.ok(result.distances[1] > MEDIUM_CONFIDENCE_MAX_DISTANCE);
    for (const i of [0, 2, 3]) assert.ok(result.distances[i] < 0.02, `red ${i} distance ${result.distances[i]}`);
  });

  it("medoid is the sample with the smallest summed distance (ties → lowest index)", () => {
    const samples = [{ hex: "#000000" }, { hex: "#808080" }, { hex: "#FFFFFF" }];
    const result = aggregateHexSamples(samples);
    assert.equal(result.hex, "#808080");
    assert.equal(result.medoidIndex, 1);

    const tie = aggregateHexSamples([{ hex: "#336699" }, { hex: "#336699" }]);
    assert.equal(tie.medoidIndex, 0);
  });

  it("spread is the mean OKLAB distance of the other samples to the medoid", () => {
    const samples = [{ hex: "#336699" }, { hex: "#3366AA" }, { hex: "#3366BB" }];
    const result = aggregateHexSamples(samples);
    const medoidLab = hexToOklab(result.hex);
    const expected =
      samples
        .filter((_, i) => i !== result.medoidIndex)
        .reduce((sum, s) => sum + oklabDistance(medoidLab, hexToOklab(s.hex)), 0) /
      (samples.length - 1);
    assert.ok(Math.abs(result.spread - expected) < 1e-4, `${result.spread} vs ${expected}`);
  });

  it("identical samples give spread 0, agreement 1 and confidence equal to the mean reported confidence blend", () => {
    const result = aggregateHexSamples([
      { hex: "#336699", confidence: 1 },
      { hex: "#336699", confidence: 1 },
      { hex: "336699", confidence: 1 },
    ]);
    assert.equal(result.spread, 0);
    assert.equal(result.agreement, 1);
    assert.equal(result.confidence, 1);
    assert.equal(result.hex, "#336699");
  });

  it("maps spread to agreement linearly down to 0 at the MEDIUM threshold", () => {
    assert.equal(ENSEMBLE_SPREAD_ZERO_AGREEMENT, MEDIUM_CONFIDENCE_MAX_DISTANCE);
    assert.equal(agreementForSpread(0), 1);
    assert.equal(agreementForSpread(ENSEMBLE_SPREAD_ZERO_AGREEMENT / 2), 0.5);
    assert.equal(agreementForSpread(ENSEMBLE_SPREAD_ZERO_AGREEMENT), 0);
    assert.equal(agreementForSpread(ENSEMBLE_SPREAD_ZERO_AGREEMENT * 3), 0);
  });

  it("blends agreement 50/50 with the mean reported confidence", () => {
    // Wildly disagreeing samples → agreement 0; models still claim 0.8 → 0.4 overall.
    const disagree = aggregateHexSamples([
      { hex: "#000000", confidence: 0.8 },
      { hex: "#FFFFFF", confidence: 0.8 },
      { hex: "#FF0000", confidence: 0.8 },
    ]);
    assert.equal(disagree.agreement, 0);
    assert.equal(disagree.confidence, 0.4);

    // Perfect agreement but no reported confidence → confidence is the agreement alone.
    const noReported = aggregateHexSamples([{ hex: "#123456" }, { hex: "#123456" }]);
    assert.equal(noReported.confidence, 1);

    // Reported confidences are clamped to 0..1 and nulls are ignored in the mean.
    const mixed = aggregateHexSamples([
      { hex: "#123456", confidence: 5 },
      { hex: "#123456", confidence: null },
      { hex: "#123456", confidence: 0 },
    ]);
    assert.equal(mixed.confidence, 0.75); // 0.5 * 1 + 0.5 * mean(1, 0)
  });

  it("votes on finishes and keeps those reported by at least half the valid samples", () => {
    const result = aggregateHexSamples([
      { hex: "#336699", finishes: ["creme", "Shimmer"] },
      { hex: "#336699", finishes: ["creme", "glitter", "glitter"] },
      { hex: "#336699", finishes: ["shimmer", "creme"] },
      { hex: null, finishes: ["holographic"] }, // invalid hex: does not vote
    ]);
    assert.deepEqual(result.votes, { creme: 3, shimmer: 2, glitter: 1 });
    assert.deepEqual(result.finishes, ["creme", "shimmer"]);
  });

  it("majorityFinishes uses ceil(n/2) and returns null when nothing qualifies", () => {
    assert.deepEqual(majorityFinishes({ creme: 2, matte: 1 }, 3), ["creme"]);
    assert.deepEqual(majorityFinishes({ creme: 1, matte: 1 }, 2), ["creme", "matte"]);
    assert.equal(majorityFinishes({ creme: 1 }, 3), null);
    assert.equal(majorityFinishes({}, 3), null);
    assert.equal(majorityFinishes({ creme: 1 }, 0), null);
    assert.deepEqual(tallyFinishVotes([{ hex: "#000000", finishes: null }, { hex: "#000000" }]), {});
  });

  it("single valid sample: returns it with no spread or agreement and its own confidence", () => {
    const result = aggregateHexSamples([
      { hex: "not-a-hex", confidence: 0.9, finishes: ["matte"] },
      { hex: "#ABCDEF", confidence: 0.6, finishes: ["creme"] },
    ]);
    assert.equal(result.hex, "#ABCDEF");
    assert.equal(result.medoidIndex, 1);
    assert.equal(result.spread, null);
    assert.equal(result.agreement, null);
    assert.equal(result.confidence, 0.6);
    assert.deepEqual(result.finishes, ["creme"]);
    assert.deepEqual(result.distances, [null, 0]);
    assert.equal(result.validCount, 1);

    const noConfidence = aggregateHexSamples([{ hex: "#ABCDEF" }]);
    assert.equal(noConfidence.confidence, null);
  });

  it("all-null samples: nothing to aggregate", () => {
    const result = aggregateHexSamples([{ hex: null, confidence: 0.9 }, { hex: null }]);
    assert.deepEqual(result, {
      hex: null,
      medoidIndex: null,
      spread: null,
      agreement: null,
      confidence: null,
      finishes: null,
      votes: {},
      distances: [null, null],
      validCount: 0,
    });
    assert.equal(aggregateHexSamples([]).hex, null);
  });
});

describe("lib/ai-color-detection — buildHexDetectionRequestPayload overrides", () => {
  const url = "https://img.example.com/a.jpg";
  const vendorContext = { shadeName: "Shade", tags: ["finish:creme"] };

  it("produces the exact previous payload when no overrides are given", () => {
    for (const safePrompt of [false, true]) {
      const payload = buildHexDetectionRequestPayload(url, { vendorContext }, safePrompt);
      const legacy = buildHexDetectionRequestPayload(url, { vendorContext, temperature: undefined }, safePrompt);

      assert.deepEqual(Object.keys(payload), ["temperature", "max_tokens", "response_format", "messages"]);
      assert.equal(payload.temperature, 0);
      assert.equal(payload.max_tokens, 120);
      assert.deepEqual(payload.response_format, { type: "json_object" });
      assert.deepEqual(payload, legacy);
    }
    assert.equal(buildHexDetectionRequestPayload(url).temperature, 0);
    assert.equal(buildHexDetectionRequestPayload(url, {}).temperature, 0);
  });

  it("a temperature override changes only the temperature field", () => {
    const base = buildHexDetectionRequestPayload(url, { vendorContext });
    const warm = buildHexDetectionRequestPayload(url, { vendorContext, temperature: 0.3 });

    assert.equal(warm.temperature, 0.3);
    assert.deepEqual({ ...warm, temperature: 0 }, base);
  });

  it("clamps the temperature to the API's 0..2 range and ignores invalid values", () => {
    assert.equal(buildHexDetectionRequestPayload(url, { temperature: 7 }).temperature, 2);
    assert.equal(buildHexDetectionRequestPayload(url, { temperature: -1 }).temperature, 0);
    assert.equal(buildHexDetectionRequestPayload(url, { temperature: Number.NaN }).temperature, 0);
  });
});

describe("eval/hex/strategies/ensemble", () => {
  const {
    createEnsembleStrategy,
    resolveEnsembleConfig,
    parseEnsembleDeployments,
    DEFAULT_ENSEMBLE_SAMPLES,
    DEFAULT_ENSEMBLE_TEMPERATURE,
  } = require("../dist/eval/hex/strategies/ensemble");
  const { getStrategy, STRATEGIES } = require("../dist/eval/hex/strategies");

  const input = {
    evalCase: {
      id: "brand:shade",
      brand: "Brand",
      shadeName: "Shade",
      finishes: ["creme"],
      groundTruthHex: "#336699",
      groundTruthSource: "swatch_measured",
      source: "TestSource",
      imageUrl: "https://example.com/a.jpg",
      tags: ["finish:creme"],
    },
    image: { bytes: Buffer.alloc(0), contentType: "image/png", dataUri: "data:image/png;base64,AA==", sourceUrl: null },
  };

  it("is registered as a strategy that needs Azure OpenAI", () => {
    const strategy = getStrategy("ensemble");
    assert.ok(strategy);
    assert.equal(strategy.requiresAzureOpenAI, true);
    assert.ok(STRATEGIES.includes(strategy));
  });

  it("parses env configuration with defaults and bounds", () => {
    const defaults = resolveEnsembleConfig({}, {});
    assert.equal(defaults.samplesPerDeployment, DEFAULT_ENSEMBLE_SAMPLES);
    assert.equal(defaults.temperature, DEFAULT_ENSEMBLE_TEMPERATURE);
    assert.deepEqual(defaults.deployments, [null]);

    const custom = resolveEnsembleConfig(
      {},
      {
        HEX_DETECTION_ENSEMBLE_SAMPLES: "5",
        HEX_DETECTION_ENSEMBLE_TEMPERATURE: "0.7",
        AZURE_OPENAI_DEPLOYMENT_HEX_ENSEMBLE: " gpt-4o-mini, gpt-4.1-mini ,gpt-4o-mini,",
      }
    );
    assert.equal(custom.samplesPerDeployment, 5);
    assert.equal(custom.temperature, 0.7);
    assert.deepEqual(custom.deployments, ["gpt-4o-mini", "gpt-4.1-mini"]);

    const bounded = resolveEnsembleConfig({}, { HEX_DETECTION_ENSEMBLE_SAMPLES: "99", HEX_DETECTION_ENSEMBLE_TEMPERATURE: "abc" });
    assert.equal(bounded.samplesPerDeployment, 10);
    assert.equal(bounded.temperature, DEFAULT_ENSEMBLE_TEMPERATURE);
    assert.equal(resolveEnsembleConfig({}, { HEX_DETECTION_ENSEMBLE_SAMPLES: "0" }).samplesPerDeployment, 1);
    assert.deepEqual(parseEnsembleDeployments(undefined), [null]);
    assert.equal(resolveEnsembleConfig({ samplesPerDeployment: 2 }, { HEX_DETECTION_ENSEMBLE_SAMPLES: "7" }).samplesPerDeployment, 2);
  });

  it("samples each deployment N times with the configured temperature, caps concurrency, and aggregates", async () => {
    const calls = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const answers = {
      "gpt-a": [
        { hex: "#C0392B", confidence: 0.9, finishes: ["creme"] },
        { hex: "#2ECC71", confidence: 0.5, finishes: ["glitter"] },
      ],
      "gpt-b": [
        { hex: "#C23A2C", confidence: 0.8, finishes: ["creme", "shimmer"] },
        { hex: "#BF3828", confidence: 0.7, finishes: ["creme"] },
      ],
    };
    const detect = async (dataUri, options) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      calls.push({ dataUri, temperature: options.temperature, deployment: options.deployment });
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      const queue = answers[options.deployment];
      const answer = queue.shift();
      return { ...answer, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }, provider: "azure-openai" };
    };

    const strategy = createEnsembleStrategy({
      detect,
      config: { samplesPerDeployment: 2, temperature: 0.3, deployments: ["gpt-a", "gpt-b"], concurrency: 2 },
    });
    const output = await strategy.run(input);

    assert.equal(calls.length, 4);
    assert.ok(maxInFlight <= 2, `max in flight ${maxInFlight}`);
    assert.ok(calls.every((call) => call.temperature === 0.3 && call.dataUri === input.image.dataUri));
    assert.deepEqual(
      calls.map((call) => call.deployment).sort(),
      ["gpt-a", "gpt-a", "gpt-b", "gpt-b"]
    );

    assert.ok(["#C0392B", "#C23A2C", "#BF3828"].includes(output.hex));
    assert.deepEqual(output.finishes, ["creme"]);
    assert.equal(output.meta.samples.length, 4);
    assert.equal(output.meta.validSamples, 4);
    assert.equal(output.meta.failedSamples, 0);
    assert.equal(output.meta.samples[output.meta.medoidIndex].hex, output.hex);
    assert.equal(output.meta.samples[output.meta.medoidIndex].distanceToMedoid, 0);
    assert.ok(typeof output.meta.spread === "number");
    assert.deepEqual(output.meta.votes, { creme: 3, glitter: 1, shimmer: 1 });
    assert.deepEqual(output.meta.usageByDeployment, {
      "gpt-a": { calls: 2, promptTokens: 20, completionTokens: 10, totalTokens: 30 },
      "gpt-b": { calls: 2, promptTokens: 20, completionTokens: 10, totalTokens: 30 },
    });
    assert.deepEqual(output.meta.config.deployments, ["gpt-a", "gpt-b"]);
  });

  it("omits the deployment override for the default deployment and tolerates partial failures", async () => {
    let n = 0;
    const detect = async (_dataUri, options) => {
      assert.equal("deployment" in options, false);
      n += 1;
      if (n === 2) throw new Error("boom");
      return { hex: "#336699", confidence: 0.9, finishes: null, usage: null, provider: "azure-openai" };
    };
    const strategy = createEnsembleStrategy({ detect, config: { samplesPerDeployment: 3, deployments: [null] } });
    const output = await strategy.run(input);

    assert.equal(output.hex, "#336699");
    assert.equal(output.meta.failedSamples, 1);
    assert.equal(output.meta.validSamples, 2);
    assert.equal(output.meta.samples[1].error, "boom");
    assert.equal(output.meta.samples[1].distanceToMedoid, null);
  });

  it("throws when every sample fails (so the runner records the case as an error)", async () => {
    const detect = async () => ({ hex: null, confidence: null, finishes: null, usage: null, provider: "none" });
    const strategy = createEnsembleStrategy({ detect, config: { samplesPerDeployment: 2, deployments: [null] } });
    await assert.rejects(strategy.run(input), /All 2 ensemble samples failed: Azure OpenAI config missing/);
  });
});
