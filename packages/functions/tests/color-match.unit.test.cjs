const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");

const {
  confidenceForDistance,
  HIGH_CONFIDENCE_MAX_DISTANCE,
  MEDIUM_CONFIDENCE_MAX_DISTANCE,
  MATCH_IMAGE_LIMITS,
  normalizeHex,
  mergeSimilarColors,
  rankPolishMatches,
  rankColorMatches,
  buildPalette,
  parseMatchImageRequest,
  extractImagePalette,
  MatchImageInputError,
} = require("../dist/lib/color-match");
const { hexToOklab, oklabDistance, colorDistance } = require("swatchwatch-shared");

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

describe("swatchwatch-shared OKLAB — pinned distances", () => {
  // Values captured from the original apps/web color-utils implementation
  // before the math moved to swatchwatch-shared; they must not drift.
  const pinned = [
    ["#FFFFFF", "#000000", 0.9999999934735468],
    ["#D01020", "#D11121", 0.0023739654423271216],
    ["#1030C0", "#1838B8", 0.02035764616527137],
    ["#C8A27C", "#98FF98", 0.24239714736904028],
    ["#FF0000", "#00FF00", 0.5198128892674524],
  ];
  for (const [a, b, expected] of pinned) {
    it(`colorDistance(${a}, ${b}) = ${expected}`, () => {
      assert.equal(colorDistance(a, b), expected);
      assert.equal(oklabDistance(hexToOklab(a), hexToOklab(b)), expected);
    });
  }

  it("pins hexToOklab(#D01020)", () => {
    assert.deepEqual(hexToOklab("#D01020"), {
      L: 0.5441241136986579,
      a: 0.19323916249464554,
      b: 0.09460852498382955,
    });
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

// ── #105: per-color matches, palette quality, scope / filter parsing ─────────

describe("lib/color-match — rankColorMatches", () => {
  const red = polish(1, "#D01020", { name: "Red" });
  const darkRed = polish(2, "#A00818", { name: "Dark Red" });
  const blue = polish(3, "#1030C0", { name: "Blue" });
  const noHex = polish(4, null, { name: "No hex" });
  const colors = [
    { hex: "#D01020", fraction: 0.8 },
    { hex: "#1030c0", fraction: 0.2 },
  ];

  it("returns one group per extracted color, in palette order, each sorted by distance to that color", () => {
    const groups = rankColorMatches([blue, darkRed, red, noHex], colors, 5);
    assert.deepEqual(groups.map((g) => g.hex), ["#D01020", "#1030C0"]);
    assert.deepEqual(groups[0].matches.map((m) => m.polish.name), ["Red", "Dark Red", "Blue"]);
    assert.equal(groups[1].matches[0].polish.name, "Blue");
    assert.ok(groups.every((g) => g.matches.every((m) => m.matchedColor === g.hex)));
    assert.equal(groups[0].matches[0].distance, 0);
    assert.equal(groups[0].matches[0].confidence, "high");
  });

  it("gives a minor color its own top matches even when another color wins every polish overall", () => {
    // Every polish is closer to red, so the flat list never names blue — the per-color group still does.
    const flat = rankPolishMatches([red, darkRed], colors, 10).matches;
    assert.ok(flat.every((m) => m.matchedColor === "#D01020"));
    const groups = rankColorMatches([red, darkRed], colors, 1);
    assert.equal(groups[1].matches.length, 1);
    assert.equal(groups[1].matches[0].matchedColor, "#1030C0");
  });

  it("caps each group at perColorLimit and skips invalid palette hexes", () => {
    const groups = rankColorMatches([red, darkRed, blue], [{ hex: "nope", fraction: 1 }, ...colors], 2);
    assert.equal(groups.length, 2);
    assert.ok(groups.every((g) => g.matches.length === 2));
  });
});

describe("lib/color-match — buildPalette", () => {
  const raw = [
    { hex: "#FFFFFF", fraction: 0.5 }, // light background
    { hex: "#E0AC69", fraction: 0.2 }, // skin
    { hex: "#D01020", fraction: 0.15 }, // polish red
    { hex: "#808078", fraction: 0.1 }, // warm grey
    { hex: "#101010", fraction: 0.05 }, // dark background
  ];

  it("without options equals mergeSimilarColors plus a kind on every color", () => {
    const palette = buildPalette(raw, { maxColors: 6 });
    const merged = mergeSimilarColors(raw, { maxColors: 6 });
    assert.deepEqual(palette.map(({ hex, fraction }) => ({ hex, fraction })), merged);
    assert.deepEqual(
      palette.map((c) => c.kind),
      ["light", "skin", "color", "color", "dark"]
    );
  });

  it("drops skin and background colors when asked, freeing their palette slots", () => {
    const palette = buildPalette(raw, { maxColors: 2, excludeSkinTones: true, excludeBackground: true });
    assert.deepEqual(palette.map((c) => c.hex), ["#D01020", "#808078"]);
  });

  it("preferVibrant picks saturated colors over a larger grey area, then sorts by share", () => {
    const greyHeavy = [
      { hex: "#808080", fraction: 0.3 },
      { hex: "#7A7A7A", fraction: 0.0 }, // merged away
      { hex: "#D01020", fraction: 0.2 },
      { hex: "#1030C0", fraction: 0.18 },
    ];
    assert.deepEqual(buildPalette(greyHeavy, { maxColors: 2 }).map((c) => c.hex), ["#808080", "#D01020"]);
    assert.deepEqual(
      buildPalette(greyHeavy, { maxColors: 2, preferVibrant: true }).map((c) => c.hex),
      ["#D01020", "#1030C0"]
    );
  });
});

describe("lib/color-match — parseMatchImageRequest (#105 options)", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const image = dataUrl("image/png", png);

  it("defaults to the owned scope, no filters and no palette options", () => {
    const parsed = parseMatchImageRequest({ image });
    assert.equal(parsed.scope, "owned");
    assert.deepEqual(parsed.finishes, []);
    assert.deepEqual(parsed.families, []);
    assert.equal(parsed.perColorLimit, MATCH_IMAGE_LIMITS.defaultPerColorLimit);
    assert.equal(parsed.excludeSkinTones, false);
    assert.equal(parsed.excludeBackground, false);
    assert.equal(parsed.preferVibrant, false);
  });

  it("accepts scope, finishes, families and palette options", () => {
    const parsed = parseMatchImageRequest({
      image,
      scope: "catalog",
      finishes: [" Holo ", "holo", "", "Cream"],
      families: ["Gray", "red", "red"],
      perColorLimit: 10,
      excludeSkinTones: true,
      excludeBackground: true,
      preferVibrant: true,
    });
    assert.equal(parsed.scope, "catalog");
    assert.deepEqual(parsed.finishes, ["holo", "cream"]);
    assert.deepEqual(parsed.families, ["grey", "red"]);
    assert.equal(parsed.perColorLimit, 10);
    assert.equal(parsed.excludeSkinTones, true);
    assert.equal(parsed.excludeBackground, true);
    assert.equal(parsed.preferVibrant, true);
  });

  for (const [label, extra, pattern] of [
    ["an unknown scope", { scope: "everyone" }, /scope must be one of/],
    ["a non-array finishes", { finishes: "holo" }, /finishes must be an array/],
    ["a non-string finish", { finishes: [1] }, /finishes must be an array/],
    ["too many finishes", { finishes: Array.from({ length: 21 }, (_, i) => `f${i}`) }, /at most 20/],
    ["an over-long finish", { finishes: ["x".repeat(65)] }, /64 characters/],
    ["an unknown family", { families: ["plaid"] }, /Invalid color family: plaid/],
    ["a non-boolean option", { excludeSkinTones: "yes" }, /excludeSkinTones must be a boolean/],
    ["perColorLimit out of range", { perColorLimit: 21 }, /perColorLimit must be between/],
  ]) {
    it(`rejects ${label}`, () => {
      assert.throws(
        () => parseMatchImageRequest({ image, ...extra }),
        (err) => err instanceof MatchImageInputError && pattern.test(err.message)
      );
    });
  }
});
