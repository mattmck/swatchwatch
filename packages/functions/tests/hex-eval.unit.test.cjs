const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");

const { colorDistance } = require("swatchwatch-shared");
const { HIGH_CONFIDENCE_MAX_DISTANCE, MEDIUM_CONFIDENCE_MAX_DISTANCE } = require("../dist/lib/color-match");
const { scoreCase, summarize, buildReport, percentile, median, primaryFinishOf } = require("../dist/eval/hex/scoring");
const { parseFixture, FixtureValidationError } = require("../dist/eval/hex/fixture");
const { formatReport, renderTable, writeReportJson } = require("../dist/eval/hex/report");
const { STRATEGIES, getStrategy, pixelStrategy, strategySkipReason, azureCurrentStrategy } = require("../dist/eval/hex/strategies");
const { loadCaseImage, cacheFileFor } = require("../dist/eval/hex/images");
const { parseArgs, runStrategy } = require("../dist/eval/hex/cli");
const { selectTrainingCandidates, trainingSampleToEvalCase, parsePopulateArgs, finishesFromTags } = require("../dist/eval/hex/populate");

function evalCase(overrides = {}) {
  return {
    id: "brand:shade",
    brand: "Brand",
    shadeName: "Shade",
    finishes: ["creme"],
    groundTruthHex: "#336699",
    groundTruthSource: "manual",
    source: "TestSource",
    imageUrl: "https://example.com/a.jpg",
    ...overrides,
  };
}

function solidPng(rgb, width = 32, height = 32) {
  return sharp({
    create: { width, height, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } },
  })
    .png()
    .toBuffer();
}

// A synthetic fixture: four cases across two brands and two finishes.
const SYNTHETIC_CASES = [
  evalCase({ id: "a:1", brand: "A", finishes: ["creme"], groundTruthHex: "#336699" }),
  evalCase({ id: "a:2", brand: "A", finishes: ["metallic"], groundTruthHex: "#FF0000" }),
  evalCase({ id: "b:1", brand: "B", finishes: ["creme"], groundTruthHex: "#00FF00" }),
  evalCase({ id: "b:2", brand: "B", finishes: [], groundTruthHex: "#FFFFFF" }),
];

describe("eval/hex scoring", () => {
  it("scores an exact prediction as distance 0 / high", () => {
    const score = scoreCase(evalCase(), { hex: "336699" });
    assert.equal(score.predictedHex, "#336699");
    assert.equal(score.distance, 0);
    assert.equal(score.bucket, "high");
    assert.equal(score.primaryFinish, "creme");
  });

  it("uses the shared OKLAB distance and the color-match thresholds for buckets", () => {
    const truth = "#336699";
    const nearby = "#3A6CA0";
    const score = scoreCase(evalCase({ groundTruthHex: truth }), { hex: nearby });
    assert.equal(score.distance, Math.round(colorDistance(truth, nearby) * 1e4) / 1e4);
    assert.ok(score.distance <= HIGH_CONFIDENCE_MAX_DISTANCE);
    assert.equal(score.bucket, "high");

    const far = scoreCase(evalCase({ groundTruthHex: "#000000" }), { hex: "#FFFFFF" });
    assert.ok(far.distance > MEDIUM_CONFIDENCE_MAX_DISTANCE);
    assert.equal(far.bucket, "low");
  });

  it("records a missing prediction (null hex or error) as bucket none", () => {
    const none = scoreCase(evalCase(), { hex: null });
    assert.equal(none.distance, null);
    assert.equal(none.bucket, "none");

    const failed = scoreCase(evalCase(), null, "boom");
    assert.equal(failed.predictedHex, null);
    assert.equal(failed.error, "boom");
    assert.equal(failed.bucket, "none");
  });

  it("rejects an invalid ground truth hex", () => {
    assert.throws(() => scoreCase(evalCase({ groundTruthHex: "#12" }), { hex: "#000000" }), /groundTruthHex/);
  });

  it("computes nearest-rank percentiles and medians", () => {
    assert.equal(percentile([], 0.9), null);
    assert.equal(percentile([5, 1, 3], 0.5), 3);
    assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9);
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    assert.equal(median([]), null);
  });

  it("falls back to 'unknown' for the primary finish", () => {
    assert.equal(primaryFinishOf({ finishes: [] }), "unknown");
    assert.equal(primaryFinishOf({ finishes: [" Metallic ", "chrome"] }), "metallic");
  });

  it("summarizes counts, median/p90 over scored cases and shares over all cases", () => {
    const scores = [
      scoreCase(evalCase({ id: "1" }), { hex: "#336699" }), // 0
      scoreCase(evalCase({ id: "2" }), { hex: "#3A6CA0" }), // small
      scoreCase(evalCase({ id: "3", groundTruthHex: "#000000" }), { hex: "#FFFFFF" }), // ~1
      scoreCase(evalCase({ id: "4" }), null, "failed"), // missing
    ];
    const summary = summarize(scores);
    assert.equal(summary.count, 4);
    assert.equal(summary.scored, 3);
    assert.equal(summary.missing, 1);
    assert.equal(summary.medianDistance, scores[1].distance);
    assert.equal(summary.p90Distance, scores[2].distance);
    // 2 of 4 within HIGH; the missing one counts as outside.
    assert.equal(summary.withinHigh, 0.5);
    assert.equal(summary.withinMedium, 0.5);
  });

  it("builds a report broken down by brand and primary finish", () => {
    const scores = SYNTHETIC_CASES.map((c, i) =>
      scoreCase(c, { hex: i === 3 ? null : c.groundTruthHex })
    );
    const report = buildReport(scores, { strategy: "test", fixture: "synthetic.json", generatedAt: new Date("2026-01-01T00:00:00Z") });
    assert.equal(report.strategy, "test");
    assert.equal(report.generatedAt, "2026-01-01T00:00:00.000Z");
    assert.deepEqual(report.thresholds, { high: HIGH_CONFIDENCE_MAX_DISTANCE, medium: MEDIUM_CONFIDENCE_MAX_DISTANCE });
    assert.deepEqual(Object.keys(report.byBrand), ["A", "B"]);
    assert.equal(report.byBrand.A.count, 2);
    assert.equal(report.byBrand.A.withinHigh, 1);
    assert.equal(report.byBrand.B.scored, 1);
    assert.deepEqual(Object.keys(report.byFinish), ["creme", "metallic", "unknown"]);
    assert.equal(report.byFinish.creme.count, 2);
    assert.equal(report.byFinish.unknown.missing, 1);
    assert.equal(report.overall.count, 4);
  });
});

describe("eval/hex fixture parsing", () => {
  it("accepts a valid fixture and normalizes hex/finishes", () => {
    const fixture = parseFixture({
      version: 1,
      cases: [{ ...evalCase(), groundTruthHex: "abcdef", finishes: ["Creme"] }],
    });
    assert.equal(fixture.cases.length, 1);
    assert.equal(fixture.cases[0].groundTruthHex, "#ABCDEF");
    assert.deepEqual(fixture.cases[0].finishes, ["creme"]);
    assert.deepEqual(fixture.cases[0].tags, []);
  });

  for (const [label, mutate] of [
    ["missing hex", (c) => delete c.groundTruthHex],
    ["bad hex", (c) => (c.groundTruthHex = "#12345")],
    ["both image refs", (c) => (c.imagePath = "x.png")],
    ["no image ref", (c) => delete c.imageUrl],
    ["non-http url", (c) => (c.imageUrl = "ftp://x/y.png")],
    ["escaping imagePath", (c) => { delete c.imageUrl; c.imagePath = "../secret.png"; }],
    ["unknown ground truth source", (c) => (c.groundTruthSource = "guess")],
    ["missing brand", (c) => delete c.brand],
  ]) {
    it(`rejects a case with ${label}`, () => {
      const c = evalCase();
      mutate(c);
      assert.throws(() => parseFixture({ version: 1, cases: [c] }), FixtureValidationError);
    });
  }

  it("rejects duplicate ids, wrong version and empty case lists", () => {
    assert.throws(() => parseFixture({ version: 1, cases: [evalCase(), evalCase()] }), /duplicate case id/);
    assert.throws(() => parseFixture({ version: 2, cases: [evalCase()] }), /version/);
    assert.throws(() => parseFixture({ version: 1, cases: [] }), /non-empty/);
  });

  it("the checked-in sample fixture is valid and has at least 10 cases", async () => {
    const doc = JSON.parse(await fs.readFile(path.join(__dirname, "..", "eval", "hex", "fixtures", "sample.json"), "utf8"));
    const fixture = parseFixture(doc, "sample.json");
    assert.ok(fixture.cases.length >= 10);
    const brands = new Set(fixture.cases.map((c) => c.brand));
    assert.ok(brands.size >= 2);
  });
});

describe("eval/hex report formatting", () => {
  it("renders a padded table", () => {
    const table = renderTable(["group", "n"], [["overall", "12"], ["brand: Holo Taco", "3"]]);
    const lines = table.split("\n");
    assert.equal(lines.length, 4);
    assert.match(lines[0], /^group\s+n$/);
    assert.match(lines[3], /^brand: Holo Taco\s+3$/);
  });

  it("prints overall, brand and finish rows plus per-case rows when verbose", () => {
    const scores = SYNTHETIC_CASES.map((c) => scoreCase(c, { hex: c.groundTruthHex }));
    const report = buildReport(scores, { strategy: "pixel", fixture: "synthetic.json" });
    const text = formatReport(report);
    assert.match(text, /Strategy: pixel/);
    assert.match(text, /overall\s+4\s+4\s+0\.0000\s+0\.0000\s+100%\s+100%/);
    assert.match(text, /brand: A/);
    assert.match(text, /finish: metallic/);
    assert.doesNotMatch(text, /a:1/);
    assert.match(formatReport(report, { verbose: true }), /a:1\s+creme\s+#336699\s+#336699/);
  });

  it("writes timestamped and latest JSON files", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hex-eval-"));
    const report = buildReport([], { strategy: "pixel", fixture: "x.json", generatedAt: new Date("2026-01-02T03:04:05.000Z") });
    const written = await writeReportJson(report, dir);
    assert.equal(path.basename(written), "pixel-2026-01-02T03-04-05-000Z.json");
    const latest = JSON.parse(await fs.readFile(path.join(dir, "pixel-latest.json"), "utf8"));
    assert.equal(latest.strategy, "pixel");
    assert.equal(latest.overall.count, 0);
  });
});

describe("eval/hex strategies", () => {
  it("registers the three day-one strategies", () => {
    assert.deepEqual(STRATEGIES.map((s) => s.name), ["azure-current", "azure-blind", "pixel"]);
    assert.equal(getStrategy("PIXEL"), pixelStrategy);
    assert.equal(getStrategy("nope"), null);
    assert.equal(getStrategy("azure-current").requiresAzureOpenAI, true);
    assert.equal(getStrategy("azure-blind").requiresAzureOpenAI, true);
    assert.equal(pixelStrategy.requiresAzureOpenAI, false);
  });

  it("skips Azure strategies without config but never the pixel baseline", () => {
    assert.match(strategySkipReason(azureCurrentStrategy, false), /Azure OpenAI is not configured/);
    assert.equal(strategySkipReason(azureCurrentStrategy, true), null);
    assert.equal(strategySkipReason(pixelStrategy, false), null);
  });

  it("pixel baseline returns the dominant color of the image", async () => {
    const bytes = await solidPng([51, 102, 153]);
    const output = await pixelStrategy.run({
      evalCase: evalCase(),
      image: { bytes, contentType: "image/png", dataUri: "", sourceUrl: null },
    });
    assert.equal(output.hex, "#336699");
    assert.equal(output.meta.palette[0].fraction, 1);
  });
});

describe("eval/hex image loading", () => {
  it("loads a local imagePath relative to the fixture dir and detects the content type", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hex-eval-img-"));
    await fs.writeFile(path.join(dir, "swatch.png"), await solidPng([10, 20, 30]));
    const image = await loadCaseImage(evalCase({ imageUrl: undefined, imagePath: "swatch.png" }), { fixtureDir: dir });
    assert.equal(image.contentType, "image/png");
    assert.ok(image.dataUri.startsWith("data:image/png;base64,"));
    assert.equal(image.sourceUrl, null);
  });

  it("fetches imageUrl through the injected fetch and caches it", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hex-eval-cache-"));
    const png = await solidPng([200, 100, 0]);
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return { ok: true, status: 200, arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) };
    };
    const c = evalCase({ imageUrl: "https://example.com/swatch.png" });
    const first = await loadCaseImage(c, { fixtureDir: dir, cacheDir: dir, fetchImpl });
    const second = await loadCaseImage(c, { fixtureDir: dir, cacheDir: dir, fetchImpl });
    assert.equal(calls, 1);
    assert.equal(first.contentType, "image/png");
    assert.equal(second.sourceUrl, c.imageUrl);
  });

  it("evicts an undecodable cache entry and refetches", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hex-eval-corrupt-"));
    const url = "https://example.com/corrupt.png";
    await fs.writeFile(cacheFileFor(dir, url), Buffer.from("not an image"));
    const png = await solidPng([0, 128, 255]);
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return { ok: true, status: 200, arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) };
    };
    const image = await loadCaseImage(evalCase({ imageUrl: url }), { fixtureDir: dir, cacheDir: dir, fetchImpl });
    assert.equal(calls, 1);
    assert.equal(image.contentType, "image/png");
    assert.deepEqual(await fs.readFile(cacheFileFor(dir, url)), png);
  });

  it("does not cache fetched bytes that cannot be decoded", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hex-eval-nocache-"));
    const url = "https://example.com/garbage.png";
    const garbage = Buffer.from("<html>not an image</html>");
    const fetchImpl = async () => ({ ok: true, status: 200, arrayBuffer: async () => garbage.buffer.slice(garbage.byteOffset, garbage.byteOffset + garbage.byteLength) });
    await assert.rejects(loadCaseImage(evalCase({ imageUrl: url }), { fixtureDir: dir, cacheDir: dir, fetchImpl }));
    await assert.rejects(fs.access(cacheFileFor(dir, url)));
  });

  it("surfaces HTTP errors", async () => {
    const fetchImpl = async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) });
    await assert.rejects(
      loadCaseImage(evalCase(), { fixtureDir: os.tmpdir(), cacheDir: null, fetchImpl }),
      /HTTP 404/
    );
  });
});

describe("eval/hex cli", () => {
  it("parses strategy lists, paths and flags", () => {
    const args = parseArgs(["--strategy", "pixel,azure-blind", "-s", "azure-current", "--limit", "3", "--no-cache", "--verbose", "--only", "mooncat"]);
    assert.deepEqual(args.strategies, ["pixel", "azure-blind", "azure-current"]);
    assert.equal(args.limit, 3);
    assert.equal(args.cacheDir, null);
    assert.equal(args.verbose, true);
    assert.equal(args.only, "mooncat");
    assert.deepEqual(parseArgs(["--strategy", "all"]).strategies, ["azure-current", "azure-blind", "pixel"]);
    assert.throws(() => parseArgs(["--limit", "0"]), /--limit/);
    assert.throws(() => parseArgs(["--bogus"]), /Unknown argument/);
  });

  it("runs a strategy over local fixture images and records per-case errors without throwing", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hex-eval-run-"));
    await fs.writeFile(path.join(dir, "blue.png"), await solidPng([51, 102, 153]));
    const loaded = {
      fixturePath: path.join(dir, "fixture.json"),
      fixtureDir: dir,
      fixture: parseFixture({
        version: 1,
        cases: [
          evalCase({ id: "ok", imageUrl: undefined, imagePath: "blue.png", groundTruthHex: "#336699" }),
          evalCase({ id: "missing", imageUrl: undefined, imagePath: "nope.png" }),
        ],
      }),
    };
    const lines = [];
    const report = await runStrategy(pixelStrategy, loaded, { cacheDir: null, log: (l) => lines.push(l) });
    assert.equal(report.overall.count, 2);
    assert.equal(report.overall.scored, 1);
    assert.equal(report.cases[0].distance, 0);
    assert.equal(report.cases[1].bucket, "none");
    assert.match(report.cases[1].error, /ENOENT|no such file/i);
    assert.equal(lines.length, 2);
  });
});

describe("eval/hex populate (pure parts)", () => {
  const row = (overrides = {}) => ({
    externalProductId: 7,
    dataSourceId: 3,
    sourceName: "HoloTacoShopify",
    externalId: "123",
    brand: "Holo Taco",
    shadeName: "Pier Pressure",
    vendorHex: "#22bacc",
    primaryImageUrl: "https://cdn.example.com/hero.jpg",
    imageUrls: ["https://cdn.example.com/hero.jpg", "https://cdn.example.com/hand.jpg"],
    productHandle: "pier-pressure",
    productName: "Pier Pressure",
    ...overrides,
  });

  it("keeps real vendor hexes with an image and rejects placeholders / missing images", () => {
    const { accepted, rejected } = selectTrainingCandidates([
      row(),
      row({ externalProductId: 8, vendorHex: "#D3D3D3" }),
      row({ externalProductId: 9, vendorHex: "#000000" }),
      row({ externalProductId: 10, vendorHex: "nope" }),
      row({ externalProductId: 11, primaryImageUrl: null, imageUrls: [] }),
      row({ externalProductId: 12, primaryImageUrl: null, imageUrls: ["https://cdn.example.com/only.jpg"] }),
    ]);
    assert.equal(accepted.length, 2);
    assert.equal(accepted[0].hex, "#22BACC");
    assert.equal(accepted[0].sourceType, "vendor_option");
    assert.deepEqual(accepted[0].imageUrls, [
      { url: "https://cdn.example.com/hero.jpg", is_primary: true },
      { url: "https://cdn.example.com/hand.jpg", is_primary: false },
    ]);
    assert.equal(accepted[1].imageUrls[0].url, "https://cdn.example.com/only.jpg");
    assert.deepEqual(rejected.map((r) => r.reason), ["suspicious_hex", "suspicious_hex", "invalid_hex", "no_image"]);
  });

  it("maps a training sample row to a fixture case", () => {
    const c = trainingSampleToEvalCase({
      trainingSampleId: 42,
      hex: "22bacc",
      colorName: "Pier Pressure",
      brandName: "Holo Taco",
      productName: "Pier Pressure",
      productHandle: "pier-pressure",
      imageUrls: [{ url: "https://cdn.example.com/hand.jpg", is_primary: false }, { url: "https://cdn.example.com/hero.jpg", is_primary: true }],
      sourceType: "vendor_option",
      trainingStatus: "approved",
      notes: "from shade.vendor_hex",
      sourceName: "HoloTacoShopify",
      externalId: "123",
      tags: ["finish:creme", "color:teal"],
      finishes: null,
      bodyHtml: "<p>A bright <b>teal</b> creme.</p>",
    });
    assert.equal(c.id, "training-sample:42");
    assert.equal(c.groundTruthHex, "#22BACC");
    assert.equal(c.groundTruthSource, "vendor_option");
    assert.equal(c.imageUrl, "https://cdn.example.com/hero.jpg");
    assert.deepEqual(c.finishes, ["creme"]);
    assert.equal(c.description, "A bright teal creme.");
    assert.match(c.notes, /training_status=approved/);
    assert.equal(trainingSampleToEvalCase({ trainingSampleId: 1, hex: "#000000", imageUrls: [], brandName: "x", colorName: "y", sourceType: "manual", trainingStatus: "pending" }), null);
  });

  it("derives finishes from finish: tags, else from bare canonical finish tags", () => {
    assert.deepEqual(finishesFromTags(["color:teal", "finish:Creme", "finish:creme", "glitter"]), ["creme"]);
    assert.deepEqual(finishesFromTags(["all-products", "creme", "pastel", "Metallic"]), ["creme", "metallic"]);
    assert.deepEqual(finishesFromTags(["all-products"]), []);
  });

  it("parses populate args", () => {
    const args = parsePopulateArgs(["--source", "HoloTacoShopify, MooncatShopify", "--limit", "20", "--status", "approved", "--export-only", "--dry-run"]);
    assert.deepEqual(args.sources, ["HoloTacoShopify", "MooncatShopify"]);
    assert.equal(args.limit, 20);
    assert.deepEqual(args.statuses, ["approved"]);
    assert.equal(args.exportOnly, true);
    assert.equal(args.dryRun, true);
    assert.throws(() => parsePopulateArgs(["--limit", "-1"]), /--limit/);
  });
});
