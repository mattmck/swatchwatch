const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  buildSuspiciousHexContext,
  classifySuspiciousHex,
  isSuspiciousHexInContext,
  isSuspiciousHex,
  resolveSuspiciousHexThresholds,
  hexChroma,
  normalizeHex6,
  DEFAULT_SUSPICIOUS_HEX_REPEAT_MIN_RECORDS,
  DEFAULT_SUSPICIOUS_HEX_REPEAT_MIN_SHARE,
  DEFAULT_SUSPICIOUS_HEX_GRAYSCALE_MAX_CHROMA,
} = require("../dist/lib/suspicious-hex");

const ENV_KEYS = [
  "SUSPICIOUS_HEX_REPEAT_MIN_RECORDS",
  "SUSPICIOUS_HEX_REPEAT_MIN_SHARE",
  "SUSPICIOUS_HEX_GRAYSCALE_MAX_CHROMA",
];

function withNoThresholdEnv() {
  const saved = {};
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
}

/** A batch where every hex is unique, so nothing is a template default. */
function emptyContext() {
  return buildSuspiciousHexContext([]);
}

describe("lib/suspicious-hex — normalizeHex6", () => {
  it("uppercases and adds the hash", () => {
    assert.equal(normalizeHex6("c8a2c8"), "#C8A2C8");
    assert.equal(normalizeHex6("  #ff69b4 "), "#FF69B4");
  });

  it("returns null for non 6-digit values", () => {
    assert.equal(normalizeHex6("#FFF"), null);
    assert.equal(normalizeHex6("red"), null);
    assert.equal(normalizeHex6(""), null);
    assert.equal(normalizeHex6(null), null);
  });
});

describe("lib/suspicious-hex — buildSuspiciousHexContext repeat counting", () => {
  withNoThresholdEnv();

  it("uses the documented defaults when no env vars are set", () => {
    const ctx = buildSuspiciousHexContext([]);
    assert.equal(ctx.thresholds.repeatMinRecords, DEFAULT_SUSPICIOUS_HEX_REPEAT_MIN_RECORDS);
    assert.equal(ctx.thresholds.repeatMinShare, DEFAULT_SUSPICIOUS_HEX_REPEAT_MIN_SHARE);
    assert.equal(ctx.thresholds.grayscaleMaxChroma, DEFAULT_SUSPICIOUS_HEX_GRAYSCALE_MAX_CHROMA);
    assert.equal(DEFAULT_SUSPICIOUS_HEX_REPEAT_MIN_RECORDS, 3);
    assert.equal(DEFAULT_SUSPICIOUS_HEX_REPEAT_MIN_SHARE, 0.1);
  });

  it("counts normalized hexes and ignores missing/malformed values", () => {
    const ctx = buildSuspiciousHexContext(["#c8a2c8", "C8A2C8", null, undefined, "", "#FFF", "#4169E1"]);
    assert.equal(ctx.hexRecordCount, 3);
    assert.equal(ctx.counts.get("#C8A2C8"), 2);
    assert.equal(ctx.counts.get("#4169E1"), 1);
  });

  it("flags a hex repeated across the batch as a template default", () => {
    // 40 shades on a store template: #C8A2C8 on 38 of them, 2 real ones.
    const hexes = Array.from({ length: 38 }, () => "#C8A2C8").concat(["#4169E1", "#E64B4B"]);
    const ctx = buildSuspiciousHexContext(hexes);
    assert.deepEqual(Array.from(ctx.templateDefaults), ["#C8A2C8"]);
    assert.equal(classifySuspiciousHex("#C8A2C8", ctx, { shadeName: "Lilac Dreams" }).reason, "template-default");
    assert.equal(isSuspiciousHexInContext("#c8a2c8", ctx), true);
    // The unique hexes in the same batch are still trusted.
    assert.equal(isSuspiciousHexInContext("#E64B4B", ctx, { shadeName: "Cherry Bomb" }), false);
  });

  it("requires at least 3 records even when the share is high", () => {
    // 2 of 4 records share a hex (50%) but only 2 records -> not enough.
    const ctx = buildSuspiciousHexContext(["#8A3B5C", "#8A3B5C", "#2B6E9A", "#C47A2E"]);
    assert.equal(ctx.templateDefaults.size, 0);
    assert.equal(isSuspiciousHexInContext("#8A3B5C", ctx, { shadeName: "Berry" }), false);
  });

  it("requires at least 10% share even when the record count is reached", () => {
    // 3 of 40 records share a hex (7.5%) -> below the share threshold.
    const unique = Array.from({ length: 37 }, (_, i) => `#${(0x300000 + i * 0x1357).toString(16).padStart(6, "0").toUpperCase()}`);
    const ctx = buildSuspiciousHexContext([...unique, "#8A3B5C", "#8A3B5C", "#8A3B5C"]);
    assert.equal(ctx.hexRecordCount, 40);
    assert.equal(ctx.templateDefaults.has("#8A3B5C"), false);
  });

  it("flags exactly at the thresholds (3 records, 10%)", () => {
    const unique = Array.from({ length: 27 }, (_, i) => `#${(0x400000 + i * 0x2468).toString(16).padStart(6, "0").toUpperCase()}`);
    const ctx = buildSuspiciousHexContext([...unique, "#8A3B5C", "#8A3B5C", "#8A3B5C"]);
    assert.equal(ctx.hexRecordCount, 30);
    assert.equal(ctx.templateDefaults.has("#8A3B5C"), true);
  });

  it("honours explicit threshold overrides", () => {
    const ctx = buildSuspiciousHexContext(["#8A3B5C", "#8A3B5C", "#2B6E9A"], { repeatMinRecords: 2, repeatMinShare: 0.5 });
    assert.equal(ctx.templateDefaults.has("#8A3B5C"), true);
  });

  it("reads thresholds from env vars", () => {
    process.env.SUSPICIOUS_HEX_REPEAT_MIN_RECORDS = "2";
    process.env.SUSPICIOUS_HEX_REPEAT_MIN_SHARE = "0.25";
    process.env.SUSPICIOUS_HEX_GRAYSCALE_MAX_CHROMA = "0.05";
    const thresholds = resolveSuspiciousHexThresholds();
    assert.equal(thresholds.repeatMinRecords, 2);
    assert.equal(thresholds.repeatMinShare, 0.25);
    assert.equal(thresholds.grayscaleMaxChroma, 0.05);

    const ctx = buildSuspiciousHexContext(["#8A3B5C", "#8A3B5C", "#2B6E9A", "#C47A2E"]);
    assert.equal(ctx.templateDefaults.has("#8A3B5C"), true);
  });

  it("ignores unparseable env values and clamps out-of-range ones", () => {
    process.env.SUSPICIOUS_HEX_REPEAT_MIN_RECORDS = "many";
    process.env.SUSPICIOUS_HEX_REPEAT_MIN_SHARE = "7";
    const thresholds = resolveSuspiciousHexThresholds();
    assert.equal(thresholds.repeatMinRecords, DEFAULT_SUSPICIOUS_HEX_REPEAT_MIN_RECORDS);
    assert.equal(thresholds.repeatMinShare, 1);
  });
});

describe("lib/suspicious-hex — classifySuspiciousHex static reasons", () => {
  withNoThresholdEnv();

  it("reports missing and malformed values", () => {
    const ctx = emptyContext();
    assert.equal(classifySuspiciousHex(null, ctx).reason, "missing");
    assert.equal(classifySuspiciousHex("   ", ctx).reason, "missing");
    assert.equal(classifySuspiciousHex("#FFF", ctx).reason, "malformed");
    assert.equal(classifySuspiciousHex("purple", ctx).reason, "malformed");
  });

  it("still flags the static placeholder set", () => {
    const ctx = emptyContext();
    for (const hex of ["#000000", "#FFFFFF", "#D3D3D3", "#FF0000", "#00FFFF"]) {
      const verdict = classifySuspiciousHex(hex, ctx, { shadeName: "Anything" });
      assert.equal(verdict.suspicious, true, hex);
      assert.equal(verdict.reason, "placeholder", hex);
      assert.equal(isSuspiciousHex(hex), true, hex);
    }
  });

  it("returns a null reason for a trustworthy saturated hex", () => {
    const verdict = classifySuspiciousHex("#E64B4B", emptyContext(), { shadeName: "Cherry Bomb" });
    assert.deepEqual(verdict, { suspicious: false, reason: null, detail: null });
  });
});

describe("lib/suspicious-hex — near-grayscale heuristic", () => {
  withNoThresholdEnv();

  it("measures zero chroma for pure grays and real chroma for colors", () => {
    assert.ok(hexChroma("#7F7F7F") < 1e-6);
    assert.ok(hexChroma("#E64B4B") > 0.1);
    assert.ok(hexChroma("#D4A574") > DEFAULT_SUSPICIOUS_HEX_GRAYSCALE_MAX_CHROMA, "a nude is not near-grayscale");
  });

  it("flags a near-gray hex when the name gives no gray/metal hint", () => {
    const verdict = classifySuspiciousHex("#A1A3A6", emptyContext(), { shadeName: "Tropical Sunset", tags: ["finish:creme"] });
    assert.equal(verdict.suspicious, true);
    assert.equal(verdict.reason, "near-grayscale");
    assert.match(verdict.detail, /near-grayscale/);
  });

  it("flags a near-gray hex with no hints at all", () => {
    assert.equal(classifySuspiciousHex("#7F7F7F", emptyContext()).reason, "near-grayscale");
  });

  it("allows a near-gray hex when the shade name says gray/silver/black/white/nude/chrome", () => {
    const ctx = emptyContext();
    const cases = [
      ["#A1A3A6", "Stormy Grey"],
      ["#A1A3A6", "Silver Lining"],
      ["#1B1B1C", "Black Tie"],
      ["#F7F7F6", "Snow White"],
      ["#CFC9C3", "Barely Nude"],
      ["#B5B6B8", "Mirror Chrome"],
      ["#6E6E70", "Charcoal Sketch"],
    ];
    for (const [hex, shadeName] of cases) {
      const verdict = classifySuspiciousHex(hex, ctx, { shadeName });
      assert.equal(verdict.suspicious, false, `${shadeName} ${hex}: ${verdict.detail}`);
    }
  });

  it("allows a near-gray hex when the tags carry the hint", () => {
    const verdict = classifySuspiciousHex("#A1A3A6", emptyContext(), {
      shadeName: "Moon Dust",
      tags: ["color:silver", "finish:chrome"],
    });
    assert.equal(verdict.suspicious, false);
  });

  it("does not match hint words as substrings of other words", () => {
    // "ashley" should not count as "ash".
    const verdict = classifySuspiciousHex("#A1A3A6", emptyContext(), { shadeName: "Ashley's Garden" });
    assert.equal(verdict.reason, "near-grayscale");
  });

  it("respects the chroma threshold override", () => {
    const strict = buildSuspiciousHexContext([], { grayscaleMaxChroma: 0 });
    assert.equal(classifySuspiciousHex("#A1A3A6", strict, { shadeName: "Tropical Sunset" }).suspicious, false);

    const loose = buildSuspiciousHexContext([], { grayscaleMaxChroma: 0.2 });
    assert.equal(classifySuspiciousHex("#D4A574", loose, { shadeName: "Tropical Sunset" }).reason, "near-grayscale");
  });
});

describe("lib/suspicious-hex — web-palette heuristic", () => {
  withNoThresholdEnv();

  it("flags an exact web color whose name the shade does not carry", () => {
    const verdict = classifySuspiciousHex("#FF69B4", emptyContext(), { shadeName: "Midnight Garden" });
    assert.equal(verdict.suspicious, true);
    assert.equal(verdict.reason, "web-palette");
    assert.match(verdict.detail, /hot pink/);
  });

  it("flags other exact palette entries (royal blue, emerald, lilac) without a name hint", () => {
    const ctx = emptyContext();
    assert.equal(classifySuspiciousHex("#4169E1", ctx, { shadeName: "Deep Sea Diver" }).reason, "web-palette");
    assert.equal(classifySuspiciousHex("#50C878", ctx, { shadeName: "Forest Walk" }).reason, "web-palette");
    assert.equal(classifySuspiciousHex("#C8A2C8", ctx, { shadeName: "Twilight Hour" }).reason, "web-palette");
  });

  it("allows an exact web color when the shade name uses the full color phrase", () => {
    assert.equal(classifySuspiciousHex("#FF69B4", emptyContext(), { shadeName: "Hot Pink Summer" }).suspicious, false);
    assert.equal(classifySuspiciousHex("#4169E1", emptyContext(), { shadeName: "Royal Blue Velvet" }).suspicious, false);
  });

  it("allows an exact web color when the shade name uses the base color word", () => {
    assert.equal(classifySuspiciousHex("#FF69B4", emptyContext(), { shadeName: "Pink Lemonade" }).suspicious, false);
    assert.equal(classifySuspiciousHex("#50C878", emptyContext(), { shadeName: "Emerald City" }).suspicious, false);
  });

  it("allows an exact web color when a tag names the color", () => {
    const verdict = classifySuspiciousHex("#FF69B4", emptyContext(), {
      shadeName: "Midnight Garden",
      tags: ["color:hot pink", "finish:creme"],
    });
    assert.equal(verdict.suspicious, false);
  });

  it("is case-insensitive on both hex and name", () => {
    assert.equal(classifySuspiciousHex("#ff69b4", emptyContext(), { shadeName: "HOT PINK" }).suspicious, false);
    assert.equal(classifySuspiciousHex("ff69b4", emptyContext(), { shadeName: "Night Sky" }).reason, "web-palette");
  });

  it("matches color words on whole tokens only, not inside other words", () => {
    const ctx = emptyContext();
    // rose #FF007F, gold #FFD700, teal #008080, mint #98FF98, rust #B7410E
    assert.equal(classifySuspiciousHex("#FF007F", ctx, { shadeName: "Primrose Path" }).reason, "web-palette");
    assert.equal(classifySuspiciousHex("#FFD700", ctx, { shadeName: "Marigold Field" }).reason, "web-palette");
    assert.equal(classifySuspiciousHex("#008080", ctx, { shadeName: "Steal The Show" }).reason, "web-palette");
    assert.equal(classifySuspiciousHex("#98FF98", ctx, { shadeName: "Peppermint Patty" }).reason, "web-palette");
    assert.equal(classifySuspiciousHex("#B7410E", ctx, { shadeName: "Pie Crust" }).reason, "web-palette");
    // ...while the whole word still clears it.
    assert.equal(classifySuspiciousHex("#FF007F", ctx, { shadeName: "Rose Petal" }).suspicious, false);
    assert.equal(classifySuspiciousHex("#FFD700", ctx, { shadeName: "Gold Rush" }).suspicious, false);
  });

  it("does not flag near-but-not-exact palette values", () => {
    assert.equal(classifySuspiciousHex("#FF68B4", emptyContext(), { shadeName: "Midnight Garden" }).suspicious, false);
  });
});

describe("lib/suspicious-hex — reason precedence", () => {
  withNoThresholdEnv();

  it("reports template-default before web-palette for a repeated palette hex", () => {
    const ctx = buildSuspiciousHexContext(["#FF69B4", "#FF69B4", "#FF69B4", "#4169E1"]);
    const verdict = classifySuspiciousHex("#FF69B4", ctx, { shadeName: "Hot Pink" });
    assert.equal(verdict.reason, "template-default");
  });

  it("reports placeholder before template-default", () => {
    const ctx = buildSuspiciousHexContext(["#D3D3D3", "#D3D3D3", "#D3D3D3"]);
    assert.equal(classifySuspiciousHex("#D3D3D3", ctx).reason, "placeholder");
  });
});
