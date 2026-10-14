const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");

const {
  confidenceForDistance,
  HIGH_CONFIDENCE_MAX_DISTANCE,
  MEDIUM_CONFIDENCE_MAX_DISTANCE,
  MATCH_IMAGE_LIMITS,
  hexToOklab,
  oklabDistance,
  normalizeHex,
  mergeSimilarColors,
  rankPolishMatches,
  parseMatchImageRequest,
  extractImagePalette,
  MatchImageInputError,
} = require("../dist/lib/color-match");

function polish(id, hex, extra = {}) {
  return {
    id: String(id),
    shadeId: String(id),
    userId: "1",
    brand: extra.brand ?? "Brand",
    name: extra.name ?? `Shade ${id}`,
    color: "",
    vendorHex: hex,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...extra,
  };
}

function solidPng(rgb, width = 32, height = 32) {
  return sharp({
    create: { width, height, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } },
  })
    .png()
    .toBuffer();
}

function splitPng(left, right, width = 40, height = 40) {
  const buf = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = x < width / 2 ? left : right;
      const i = (y * width + x) * 3;
      buf[i] = r;
      buf[i + 1] = g;
      buf[i + 2] = b;
    }
  }
  return sharp(buf, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

function dataUrl(mime, bytes) {
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
}

describe("lib/color-match — confidenceForDistance", () => {
  it("uses high ≤ HIGH < medium ≤ MEDIUM < low", () => {
    assert.ok(HIGH_CONFIDENCE_MAX_DISTANCE < MEDIUM_CONFIDENCE_MAX_DISTANCE);
    assert.equal(confidenceForDistance(0), "high");
    assert.equal(confidenceForDistance(HIGH_CONFIDENCE_MAX_DISTANCE), "high");
    assert.equal(confidenceForDistance(HIGH_CONFIDENCE_MAX_DISTANCE + 0.0001), "medium");
    assert.equal(confidenceForDistance(MEDIUM_CONFIDENCE_MAX_DISTANCE), "medium");
    assert.equal(confidenceForDistance(MEDIUM_CONFIDENCE_MAX_DISTANCE + 0.0001), "low");
    assert.equal(confidenceForDistance(1), "low");
  });
});

describe("lib/color-match — OKLAB helpers", () => {
  it("matches the web colorDistance scale (white↔black ≈ 1, identical = 0)", () => {
    const white = hexToOklab("#FFFFFF");
    const black = hexToOklab("#000000");
    assert.ok(Math.abs(white.L - 1) < 1e-3, `white L=${white.L}`);
    assert.ok(Math.abs(black.L) < 1e-9);
    assert.ok(Math.abs(oklabDistance(white, black) - 1) < 1e-3);
    assert.equal(oklabDistance(hexToOklab("#AB12CD"), hexToOklab("#ab12cd")), 0);
  });

  it("normalizeHex accepts 6-digit hex with or without # and rejects others", () => {
    assert.equal(normalizeHex("ff00aa"), "#FF00AA");
    assert.equal(normalizeHex(" #Ff00aA "), "#FF00AA");
    assert.equal(normalizeHex("#FFF"), null);
    assert.equal(normalizeHex("red"), null);
    assert.equal(normalizeHex(undefined), null);
  });
});

describe("lib/color-match — mergeSimilarColors", () => {
  it("merges near-identical colors and sums their fractions", () => {
    const merged = mergeSimilarColors(
      [
        { hex: "#C8A27C", fraction: 0.4 },
        { hex: "#CAA47E", fraction: 0.2 }, // ~same beige
        { hex: "#D01020", fraction: 0.3 },
      ],
      { maxColors: 5 }
    );
    assert.equal(merged.length, 2);
    assert.equal(merged[0].hex, "#C8A27C");
    assert.ok(Math.abs(merged[0].fraction - 0.6) < 1e-9);
    assert.equal(merged[1].hex, "#D01020");
  });

  it("drops colors below the minimum fraction and caps at maxColors", () => {
    const merged = mergeSimilarColors(
      [
        { hex: "#FF0000", fraction: 0.5 },
        { hex: "#00FF00", fraction: 0.3 },
        { hex: "#0000FF", fraction: 0.195 },
        { hex: "#FFFF00", fraction: 0.005 },
      ],
      { maxColors: 2 }
    );
    assert.deepEqual(
      merged.map((c) => c.hex),
      ["#FF0000", "#00FF00"]
    );
    const all = mergeSimilarColors(
      [
        { hex: "#FF0000", fraction: 0.995 },
        { hex: "#0000FF", fraction: 0.005 },
      ],
      { maxColors: 5 }
    );
    assert.deepEqual(all.map((c) => c.hex), ["#FF0000"]);
  });
});

describe("lib/color-match — rankPolishMatches", () => {
  const palette = [
    { hex: "#D01020", fraction: 0.6 }, // red
    { hex: "#1030C0", fraction: 0.4 }, // blue
  ];

  it("scores by min distance to any extracted color and sorts ascending", () => {
    const polishes = [
      polish(1, "#FFFF00", { name: "Yellow" }),
      polish(2, "#1131C1", { name: "Near Blue" }),
      polish(3, "#D01020", { name: "Exact Red" }),
      polish(4, "#A01830", { name: "Dark Red" }),
    ];
    const { matches, candidateCount } = rankPolishMatches(polishes, palette, 10);

    assert.equal(candidateCount, 4);
    assert.deepEqual(
      matches.map((m) => m.polish.name),
      ["Exact Red", "Near Blue", "Dark Red", "Yellow"]
    );
    assert.equal(matches[0].distance, 0);
    assert.equal(matches[0].matchedColor, "#D01020");
    assert.equal(matches[0].confidence, "high");
    assert.equal(matches[1].matchedColor, "#1030C0");
    assert.equal(matches[1].confidence, "high");
    assert.equal(matches[3].confidence, "low");
    for (let i = 1; i < matches.length; i++) {
      assert.ok(matches[i - 1].distance <= matches[i].distance);
    }
  });

  it("respects the limit and skips polishes without a usable hex", () => {
    const polishes = [
      polish(1, "#D01020"),
      polish(2, undefined),
      polish(3, "not-a-hex"),
      polish(4, undefined, { detectedHex: "#1030C0" }),
      polish(5, "#D11121"),
    ];
    const { matches, candidateCount } = rankPolishMatches(polishes, palette, 2);
    assert.equal(candidateCount, 3);
    assert.equal(matches.length, 2);
    assert.ok(matches.every((m) => ["1", "4", "5"].includes(m.polish.id)));
  });

  it("prefers vendorHex over detectedHex/nameHex (resolveDisplayHex order)", () => {
    const p = polish(1, "#1030C0", { detectedHex: "#D01020", nameHex: "#D01020" });
    const { matches } = rankPolishMatches([p], palette, 5);
    assert.equal(matches[0].matchedColor, "#1030C0");
  });

  it("breaks distance ties by brand then name", () => {
    const polishes = [
      polish(1, "#D01020", { brand: "Zoya", name: "A" }),
      polish(2, "#D01020", { brand: "ILNP", name: "B" }),
      polish(3, "#D01020", { brand: "ILNP", name: "A" }),
    ];
    const { matches } = rankPolishMatches(polishes, palette, 5);
    assert.deepEqual(matches.map((m) => m.polish.id), ["3", "2", "1"]);
  });

  it("returns no matches when there are no extracted colors", () => {
    const { matches, candidateCount } = rankPolishMatches([polish(1, "#D01020")], [], 5);
    assert.deepEqual(matches, []);
    assert.equal(candidateCount, 0);
  });
});

describe("lib/color-match — parseMatchImageRequest", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  it("accepts a base64 image data URL and applies defaults", () => {
    const parsed = parseMatchImageRequest({ image: dataUrl("image/png", png) });
    assert.equal(parsed.mimeType, "image/png");
    assert.ok(Buffer.isBuffer(parsed.bytes));
    assert.equal(parsed.bytes.length, png.length);
    assert.equal(parsed.maxColors, MATCH_IMAGE_LIMITS.defaultMaxColors);
    assert.equal(parsed.limit, MATCH_IMAGE_LIMITS.defaultLimit);
  });

  it("accepts explicit maxColors / limit within range", () => {
    const parsed = parseMatchImageRequest({ image: dataUrl("image/jpeg", png), maxColors: 3, limit: 5 });
    assert.equal(parsed.maxColors, 3);
    assert.equal(parsed.limit, 5);
  });

  const badBodies = [
    ["null body", null],
    ["array body", []],
    ["missing image", {}],
    ["non-string image", { image: 42 }],
    ["https URL instead of data URL", { image: "https://example.com/a.png" }],
    ["non-image MIME", { image: dataUrl("text/plain", Buffer.from("hello")) }],
    ["unsupported image MIME", { image: dataUrl("image/svg+xml", Buffer.from("<svg/>")) }],
    ["non-base64 data URL", { image: "data:image/png,rawbytes" }],
    ["invalid base64 payload", { image: "data:image/png;base64,@@@@" }],
    ["empty payload", { image: "data:image/png;base64," }],
    ["maxColors out of range", { image: dataUrl("image/png", png), maxColors: 0 }],
    ["maxColors too large", { image: dataUrl("image/png", png), maxColors: 99 }],
    ["limit non-integer", { image: dataUrl("image/png", png), limit: 2.5 }],
    ["limit as string", { image: dataUrl("image/png", png), limit: "10" }],
  ];
  for (const [label, body] of badBodies) {
    it(`rejects ${label}`, () => {
      assert.throws(() => parseMatchImageRequest(body), MatchImageInputError);
    });
  }

  it("rejects images over the 5MB decoded limit", () => {
    const big = Buffer.alloc(5 * 1024 * 1024 + 1, 1);
    assert.throws(
      () => parseMatchImageRequest({ image: dataUrl("image/png", big) }),
      (err) => err instanceof MatchImageInputError && /too large/i.test(err.message)
    );
  });
});

describe("lib/color-match — extractImagePalette", () => {
  it("extracts the two colors of a split image", async () => {
    const png = await splitPng([208, 16, 32], [16, 48, 192]);
    const palette = await extractImagePalette(png, 6);
    const hexes = palette.map((c) => c.hex);
    assert.ok(hexes.includes("#D01020"), hexes.join(","));
    assert.ok(hexes.includes("#1030C0"), hexes.join(","));
    assert.ok(palette.every((c) => c.fraction > 0.3));
  });

  it("returns a single color for a solid image", async () => {
    const palette = await extractImagePalette(await solidPng([171, 205, 239]), 6);
    assert.equal(palette.length, 1);
    assert.equal(palette[0].hex, "#ABCDEF");
  });

  it("rejects bytes that are not a decodable image", async () => {
    await assert.rejects(
      () => extractImagePalette(Buffer.from("definitely not an image"), 6),
      MatchImageInputError
    );
  });
});
