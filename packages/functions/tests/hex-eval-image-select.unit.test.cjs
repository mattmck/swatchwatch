const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");

const { parseFixture, FixtureValidationError } = require("../dist/eval/hex/fixture");
const { buildStrategyCaseImages, loadCaseImage } = require("../dist/eval/hex/images");
const { runStrategy } = require("../dist/eval/hex/cli");
const { STRATEGIES, getStrategy } = require("../dist/eval/hex/strategies");
const { imageSelectStrategy, imageSelectAiStrategy, chooseCaseImage, parseSwatchPickResponse } = require("../dist/eval/hex/strategies/image-select");
const { selectTrainingCandidates, trainingSampleToEvalCase } = require("../dist/eval/hex/populate");

function evalCase(overrides = {}) {
  return {
    id: "brand:shade",
    brand: "Brand",
    shadeName: "Shade",
    finishes: ["creme"],
    groundTruthHex: "#336699",
    groundTruthSource: "manual",
    source: "TestSource",
    imageUrl: "https://example.com/bottle.jpg",
    ...overrides,
  };
}

function solidPng(rgb, width = 16, height = 16) {
  return sharp({ create: { width, height, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }).png().toBuffer();
}

const IMAGES = [
  { url: "https://example.com/bottle.jpg", alt: "Bottle hero", position: 1 },
  { url: "https://example.com/hand.jpg", alt: "Swatch on nails", position: 2 },
];

describe("eval/hex fixture — optional images list", () => {
  it("parses images with url/alt/position and keeps imageUrl as the primary", () => {
    const fixture = parseFixture({ version: 1, cases: [evalCase({ images: IMAGES })] });
    assert.deepEqual(fixture.cases[0].images, IMAGES);
    assert.equal(fixture.cases[0].imageUrl, "https://example.com/bottle.jpg");
  });

  it("existing cases without images stay valid and have no images key", () => {
    const fixture = parseFixture({ version: 1, cases: [evalCase()] });
    assert.equal("images" in fixture.cases[0], false);
  });

  it("normalizes alt whitespace, drops empty alt/position and tolerates an empty list", () => {
    const fixture = parseFixture({
      version: 1,
      cases: [evalCase({ images: [{ url: "https://example.com/a.jpg", alt: "  two  coats ", position: 1 }, { url: "https://example.com/b.jpg", alt: "" }] })],
    });
    assert.deepEqual(fixture.cases[0].images, [
      { url: "https://example.com/a.jpg", alt: "two coats", position: 1 },
      { url: "https://example.com/b.jpg" },
    ]);
    assert.equal("images" in parseFixture({ version: 1, cases: [evalCase({ images: [] })] }).cases[0], false);
  });

  for (const [label, images] of [
    ["a non-array", "https://example.com/a.jpg"],
    ["a non-http url", [{ url: "ftp://x/a.jpg" }]],
    ["a missing url", [{ alt: "swatch" }]],
    ["a non-integer position", [{ url: "https://example.com/a.jpg", position: 1.5 }]],
    ["a non-string alt", [{ url: "https://example.com/a.jpg", alt: 4 }]],
  ]) {
    it(`rejects images with ${label}`, () => {
      assert.throws(() => parseFixture({ version: 1, cases: [evalCase({ images })] }), FixtureValidationError);
    });
  }
});

describe("eval/hex images — lazy per-candidate loaders", () => {
  it("builds one lazy loader per image, in fixture order, loading through the cache", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hex-eval-lazy-"));
    const bottle = await solidPng([255, 255, 255]);
    const hand = await solidPng([51, 102, 153]);
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      const png = url.endsWith("hand.jpg") ? hand : bottle;
      return { ok: true, status: 200, arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) };
    };
    const loaders = buildStrategyCaseImages(evalCase({ images: IMAGES }), { fixtureDir: dir, cacheDir: dir, fetchImpl });
    assert.equal(loaders.length, 2);
    assert.deepEqual(loaders.map((l) => [l.index, l.url, l.alt, l.position]), [[0, IMAGES[0].url, "Bottle hero", 1], [1, IMAGES[1].url, "Swatch on nails", 2]]);
    assert.deepEqual(calls, [], "nothing is fetched until load() is called");
    const image = await loaders[1].load();
    assert.equal(image.contentType, "image/png");
    assert.equal(image.sourceUrl, IMAGES[1].url);
    await loaders[1].load();
    assert.deepEqual(calls, [IMAGES[1].url], "second load() hits the cache");
  });

  it("returns an empty list for cases without images", () => {
    assert.deepEqual(buildStrategyCaseImages(evalCase(), { fixtureDir: os.tmpdir(), cacheDir: null }), []);
  });
});

describe("eval/hex cli — strategies receive the candidate list", () => {
  it("passes images to the strategy only when the case has them", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hex-eval-run-images-"));
    await fs.writeFile(path.join(dir, "blue.png"), await solidPng([51, 102, 153]));
    const seen = [];
    const spy = {
      name: "spy",
      description: "records inputs",
      requiresAzureOpenAI: false,
      run: async (input) => {
        seen.push(input.images ? input.images.map((i) => i.url) : null);
        return { hex: "#336699" };
      },
    };
    const loaded = {
      fixturePath: path.join(dir, "fixture.json"),
      fixtureDir: dir,
      fixture: parseFixture({
        version: 1,
        cases: [
          evalCase({ id: "plain", imageUrl: undefined, imagePath: "blue.png" }),
          evalCase({ id: "with-images", imageUrl: undefined, imagePath: "blue.png", images: IMAGES }),
        ],
      }),
    };
    const report = await runStrategy(spy, loaded, { cacheDir: null, log: () => {} });
    assert.equal(report.overall.scored, 2);
    assert.deepEqual(seen, [null, IMAGES.map((i) => i.url)]);
  });
});

describe("eval/hex strategies/image-select — chooseCaseImage (no AI)", () => {
  const caseImage = { bytes: Buffer.alloc(0), contentType: "image/png", dataUri: "data:image/png;base64,", sourceUrl: "https://example.com/bottle.jpg" };
  const lazy = (image, index, loaded) => ({ ...image, index, load: async () => loaded });

  it("uses the case image when the case has no images list", async () => {
    const choice = chooseCaseImage({ evalCase: evalCase(), image: caseImage });
    assert.equal(choice.source, "case-image");
    assert.equal(choice.url, "https://example.com/bottle.jpg");
    assert.equal(choice.index, null);
    assert.equal(await choice.load(), caseImage);
  });

  it("picks the confident alt-text swatch and loads that candidate", async () => {
    const hand = { ...caseImage, sourceUrl: IMAGES[1].url };
    const choice = chooseCaseImage({
      evalCase: evalCase({ images: IMAGES }),
      image: caseImage,
      images: [lazy(IMAGES[0], 0, caseImage), lazy(IMAGES[1], 1, hand)],
    });
    assert.equal(choice.source, "ranked");
    assert.equal(choice.confident, true);
    assert.equal(choice.index, 1);
    assert.equal(choice.url, IMAGES[1].url);
    assert.match(choice.reason, /swatch/);
    assert.equal(choice.ranking.length, 2);
    assert.equal(await choice.load(), hand);
  });

  it("follows a filename-only hint in the eval but records it as not confident", async () => {
    const hand = { ...caseImage, sourceUrl: IMAGES[1].url };
    const plain = IMAGES.map((image) => ({ ...image, alt: null }));
    const choice = chooseCaseImage({
      evalCase: evalCase({ images: plain }),
      image: caseImage,
      images: [lazy(plain[0], 0, caseImage), lazy(plain[1], 1, hand)],
    });
    assert.equal(choice.source, "ranked");
    assert.equal(choice.index, 1);
    assert.equal(choice.confident, false);
    assert.match(choice.reason, /url mentions hand/);
  });

  it("falls back to the case's primary image (without reloading it) when there is no positive signal", async () => {
    let loads = 0;
    const plain = [
      { url: "https://example.com/a.jpg", alt: null, position: 1 },
      { url: "https://example.com/b.jpg", alt: null, position: 2 },
    ];
    const choice = chooseCaseImage({
      evalCase: evalCase({ images: plain }),
      image: caseImage,
      images: plain.map((image, index) => ({ ...image, index, load: async () => { loads += 1; return caseImage; } })),
    });
    assert.equal(choice.source, "primary");
    assert.equal(choice.confident, false);
    assert.equal(choice.url, "https://example.com/bottle.jpg");
    assert.equal(await choice.load(), caseImage);
    assert.equal(loads, 0);
  });
});

describe("eval/hex strategies/image-select — AI swatch pick response parsing", () => {
  it("accepts a valid index within range", () => {
    assert.deepEqual(parseSwatchPickResponse('{"index": 1, "confidence": 0.8}', 3), { index: 1, confidence: 0.8 });
  });
  it("rejects out-of-range, missing or malformed answers", () => {
    assert.deepEqual(parseSwatchPickResponse('{"index": 3}', 3), { index: null, confidence: null });
    assert.deepEqual(parseSwatchPickResponse('{"index": -1}', 3), { index: null, confidence: null });
    assert.deepEqual(parseSwatchPickResponse("nope", 3), { index: null, confidence: null });
    assert.deepEqual(parseSwatchPickResponse('{"index": null}', 3), { index: null, confidence: null });
  });
  it("tolerates a fenced JSON block and clamps confidence", () => {
    assert.deepEqual(parseSwatchPickResponse('```json\n{"index": 0, "confidence": 7}\n```', 2), { index: 0, confidence: 1 });
  });
});

describe("eval/hex strategies — registry includes image-select", () => {
  it("registers both image-select strategies as Azure strategies", () => {
    assert.equal(getStrategy("image-select"), imageSelectStrategy);
    assert.equal(getStrategy("image-select-ai"), imageSelectAiStrategy);
    assert.equal(imageSelectStrategy.requiresAzureOpenAI, true);
    assert.equal(imageSelectAiStrategy.requiresAzureOpenAI, true);
    assert.ok(STRATEGIES.includes(imageSelectStrategy));
  });

  it("image-select throws the standard 'config missing' error when Azure is unavailable", async () => {
    const saved = {};
    for (const key of ["AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_KEY", "AZURE_OPENAI_GATEWAY_ENDPOINT", "AZURE_OPENAI_DEPLOYMENT_HEX", "AZURE_OPENAI_DEPLOYMENT"]) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    try {
      await assert.rejects(
        imageSelectStrategy.run({ evalCase: evalCase(), image: { bytes: Buffer.alloc(0), contentType: "image/png", dataUri: "data:image/png;base64,", sourceUrl: null } }),
        /Azure OpenAI config missing/
      );
    } finally {
      for (const [key, value] of Object.entries(saved)) if (value !== undefined) process.env[key] = value;
    }
  });
});

describe("eval/hex populate — image metadata flows into fixtures", () => {
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
    images: [
      { url: "https://cdn.example.com/hero.jpg", alt: "Bottle hero", position: 1 },
      { url: "https://cdn.example.com/hand.jpg", alt: "Swatch on nails", position: 2 },
    ],
    productHandle: "pier-pressure",
    productName: "Pier Pressure",
    ...overrides,
  });

  it("keeps alt/position on training sample image rows when the connector stored them", () => {
    const { accepted } = selectTrainingCandidates([row()]);
    assert.deepEqual(accepted[0].imageUrls, [
      { url: "https://cdn.example.com/hero.jpg", is_primary: true, alt: "Bottle hero", position: 1 },
      { url: "https://cdn.example.com/hand.jpg", is_primary: false, alt: "Swatch on nails", position: 2 },
    ]);
  });

  it("stays on the bare {url, is_primary} shape for rows without image metadata", () => {
    const { accepted } = selectTrainingCandidates([row({ images: null })]);
    assert.deepEqual(accepted[0].imageUrls, [
      { url: "https://cdn.example.com/hero.jpg", is_primary: true },
      { url: "https://cdn.example.com/hand.jpg", is_primary: false },
    ]);
  });

  it("exports the images list (primary first) onto the fixture case", () => {
    const c = trainingSampleToEvalCase({
      trainingSampleId: 42,
      hex: "22bacc",
      colorName: "Pier Pressure",
      brandName: "Holo Taco",
      productName: "Pier Pressure",
      productHandle: "pier-pressure",
      imageUrls: [
        { url: "https://cdn.example.com/hand.jpg", is_primary: false, alt: "Swatch on nails", position: 2 },
        { url: "https://cdn.example.com/hero.jpg", is_primary: true, alt: "Bottle hero", position: 1 },
      ],
      sourceType: "vendor_option",
      trainingStatus: "approved",
      notes: null,
      sourceName: "HoloTacoShopify",
      externalId: "123",
      tags: [],
      finishes: null,
      bodyHtml: null,
    });
    assert.equal(c.imageUrl, "https://cdn.example.com/hero.jpg");
    assert.deepEqual(c.images, [
      { url: "https://cdn.example.com/hero.jpg", alt: "Bottle hero", position: 1 },
      { url: "https://cdn.example.com/hand.jpg", alt: "Swatch on nails", position: 2 },
    ]);
  });

  it("omits images for single-image samples without metadata", () => {
    const c = trainingSampleToEvalCase({
      trainingSampleId: 1, hex: "#22bacc", colorName: "x", brandName: "y", productName: null, productHandle: null,
      imageUrls: [{ url: "https://cdn.example.com/only.jpg", is_primary: true }],
      sourceType: "manual", trainingStatus: "pending", notes: null, sourceName: null, externalId: null, tags: null, finishes: null, bodyHtml: null,
    });
    assert.equal("images" in c, false);
  });
});

describe("eval/hex fixtures — sample-with-images", () => {
  it("validates, keeps every sample case and lists the case image first", async () => {
    const dir = path.join(__dirname, "..", "eval", "hex", "fixtures");
    const withImages = parseFixture(JSON.parse(await fs.readFile(path.join(dir, "sample-with-images.json"), "utf8")));
    const sample = parseFixture(JSON.parse(await fs.readFile(path.join(dir, "sample.json"), "utf8")));
    assert.deepEqual(withImages.cases.map((c) => c.id), sample.cases.map((c) => c.id));
    for (const c of withImages.cases) {
      assert.ok(c.images.length > 1, `${c.id} has several images`);
      assert.equal(c.images[0].url, c.imageUrl);
    }
  });
});
