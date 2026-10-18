const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  snapHexToPalette,
  resolveHexSnapMaxDistance,
  DEFAULT_HEX_SNAP_MAX_DISTANCE,
  HEX_DETECTION_METHOD_VISION_SNAP,
  isHexSnapEnabled,
  snapDetectionToCandidates,
  snapDetectionToImage,
} = require("../dist/lib/hex-snap");
const { provenanceFromDetection } = require("../dist/lib/hex-provenance");
const { HEX_DETECTION_METHOD_VISION_DIRECT, PROMPT_VERSION } = require("../dist/lib/ai-color-detection");
const sharp = require("sharp");
const { STRATEGIES } = require("../dist/eval/hex/strategies");
const { MEDIUM_CONFIDENCE_MAX_DISTANCE, hexToOklab, oklabDistance } = require("swatchwatch-shared");

const palette = [
  { label: "A", hex: "#D88C76", fraction: 0.4 }, // skin
  { label: "B", hex: "#690228", fraction: 0.2 }, // the lacquer
  { label: "C", hex: "#F4F4F4", fraction: 0.3 }, // background
];

describe("lib/hex-snap — snapHexToPalette", () => {
  it("replaces the model hex with the nearest measured chip when it is close enough", () => {
    // Model said a slightly-off oxblood; the measured chip B is the real color.
    const out = snapHexToPalette("#7A2A3D", palette);
    assert.equal(out.snapped, true);
    assert.equal(out.hex, "#690228");
    assert.equal(out.nearest.label, "B");
    const expected = oklabDistance(hexToOklab("#7A2A3D"), hexToOklab("#690228"));
    assert.ok(Math.abs(out.snapDistance - expected) < 1e-4);
  });

  it("keeps the model hex when no chip is within maxDistance", () => {
    const out = snapHexToPalette("#1E5BFF", palette);
    assert.equal(out.snapped, false);
    assert.equal(out.hex, "#1E5BFF");
    assert.ok(out.nearest, "still reports the nearest chip for diagnostics");
    assert.ok(out.snapDistance > DEFAULT_HEX_SNAP_MAX_DISTANCE);
  });

  it("honors a custom maxDistance, inclusive at the boundary", () => {
    const d = oklabDistance(hexToOklab("#7A2A3D"), hexToOklab("#690228"));
    assert.equal(snapHexToPalette("#7A2A3D", palette, d / 2).snapped, false);
    assert.equal(snapHexToPalette("#7A2A3D", palette, d).snapped, true, "distance equal to maxDistance snaps");
  });

  it("returns the input unchanged for an empty or all-invalid palette", () => {
    for (const candidates of [[], [{ hex: "nope" }, { hex: "#12345" }]]) {
      const out = snapHexToPalette("#ABCDEF", candidates);
      assert.deepEqual(
        { hex: out.hex, snapped: out.snapped, nearest: out.nearest, snapDistance: out.snapDistance },
        { hex: "#ABCDEF", snapped: false, nearest: null, snapDistance: null }
      );
    }
  });

  it("normalizes the snapped chip to uppercase #RRGGBB", () => {
    const out = snapHexToPalette("#690229", [{ hex: "690228" }]);
    assert.equal(out.hex, "#690228");
    assert.equal(snapHexToPalette("#690229", [{ hex: "#6a0228" }]).hex, "#6A0228");
  });

  it("an exact palette hit snaps with distance 0", () => {
    const out = snapHexToPalette("#F4F4F4", palette);
    assert.equal(out.snapped, true);
    assert.equal(out.snapDistance, 0);
    assert.equal(out.nearest.label, "C");
  });
});

describe("lib/hex-snap — resolveHexSnapMaxDistance", () => {
  it("defaults to the MEDIUM confidence threshold", () => {
    assert.equal(DEFAULT_HEX_SNAP_MAX_DISTANCE, MEDIUM_CONFIDENCE_MAX_DISTANCE);
    assert.equal(resolveHexSnapMaxDistance(undefined), MEDIUM_CONFIDENCE_MAX_DISTANCE);
  });

  it("accepts a positive override and ignores junk", () => {
    assert.equal(resolveHexSnapMaxDistance("0.06"), 0.06);
    for (const raw of ["", "abc", "0", "-0.1", "NaN"]) {
      assert.equal(resolveHexSnapMaxDistance(raw), MEDIUM_CONFIDENCE_MAX_DISTANCE, `raw=${JSON.stringify(raw)}`);
    }
  });
});

describe("eval/hex — snap strategies are registered", () => {
  it("registers blind-snap and image-select-ai-snap as Azure strategies", () => {
    for (const name of ["blind-snap", "image-select-ai-snap"]) {
      const strategy = STRATEGIES.find((s) => s.name === name);
      assert.ok(strategy, `${name} is registered`);
      assert.equal(strategy.requiresAzureOpenAI, true);
    }
  });
});

// ── Production post-processing ──────────────────────────────────────────────

const { afterEach } = require("node:test");

/** A `detectHexWithAzureOpenAI` result as ingestion sees it. */
function visionDetection(hex, overrides = {}) {
  return {
    hex,
    confidence: 0.8,
    finishes: ["creme"],
    usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
    provider: "azure-openai",
    method: HEX_DETECTION_METHOD_VISION_DIRECT,
    model: "gpt-4o-mini",
    promptVersion: PROMPT_VERSION,
    ...overrides,
  };
}

const solidImage = (r, g, b) =>
  sharp({ create: { width: 32, height: 32, channels: 3, background: { r, g, b } } }).png().toBuffer();

describe("lib/hex-snap — isHexSnapEnabled", () => {
  it("is off unless HEX_DETECTION_SNAP_ENABLED is literally true", () => {
    assert.equal(isHexSnapEnabled(undefined), false);
    for (const raw of ["", "false", "0", "1", "yes", "on", "enabled"]) {
      assert.equal(isHexSnapEnabled(raw), false, `raw=${JSON.stringify(raw)}`);
    }
    for (const raw of ["true", "TRUE", " True "]) {
      assert.equal(isHexSnapEnabled(raw), true, `raw=${JSON.stringify(raw)}`);
    }
  });

  it("reads process.env.HEX_DETECTION_SNAP_ENABLED by default", () => {
    const previous = process.env.HEX_DETECTION_SNAP_ENABLED;
    try {
      delete process.env.HEX_DETECTION_SNAP_ENABLED;
      assert.equal(isHexSnapEnabled(), false);
      process.env.HEX_DETECTION_SNAP_ENABLED = "true";
      assert.equal(isHexSnapEnabled(), true);
    } finally {
      if (previous === undefined) delete process.env.HEX_DETECTION_SNAP_ENABLED;
      else process.env.HEX_DETECTION_SNAP_ENABLED = previous;
    }
  });
});

describe("lib/hex-snap — snapDetectionToCandidates", () => {
  it("rewrites hex + method to vision-snap and keeps the rest of the detection", () => {
    const input = visionDetection("#7A2A3D");
    const out = snapDetectionToCandidates(input, palette);

    assert.equal(out.skipped, null);
    assert.equal(out.detection.hex, "#690228");
    assert.equal(out.detection.method, HEX_DETECTION_METHOD_VISION_SNAP);
    assert.equal(out.detection.method, "vision-snap");
    assert.equal(out.detection.confidence, 0.8);
    assert.equal(out.detection.model, "gpt-4o-mini");
    assert.equal(out.detection.promptVersion, PROMPT_VERSION, "the prompt did not change, so its version does not either");
    assert.deepEqual(out.detection.finishes, ["creme"]);
    assert.equal(out.snap.nearest.label, "B");
    assert.equal(input.hex, "#7A2A3D", "the input is not mutated");
    assert.equal(input.method, "vision-direct");
  });

  it("the stored provenance distinguishes snapped from unsnapped detections", () => {
    const snapped = snapDetectionToCandidates(visionDetection("#7A2A3D"), palette).detection;
    const kept = snapDetectionToCandidates(visionDetection("#1E5BFF"), palette).detection;
    assert.equal(provenanceFromDetection(snapped).method, "vision-snap");
    assert.equal(provenanceFromDetection(kept).method, "vision-direct");
    assert.equal(provenanceFromDetection(snapped).promptVersion, provenanceFromDetection(kept).promptVersion);
    assert.equal(provenanceFromDetection(snapped).model, "gpt-4o-mini");
  });

  it("keeps the raw detection when no chip is within maxDistance", () => {
    const input = visionDetection("#1E5BFF");
    const out = snapDetectionToCandidates(input, palette);
    assert.equal(out.skipped, "too_far");
    assert.equal(out.detection, input);
    assert.equal(out.detection.method, "vision-direct");
    assert.ok(out.snap && out.snap.snapped === false, "diagnostics still report the nearest chip");
  });

  it("honors the maxDistance argument", () => {
    const d = oklabDistance(hexToOklab("#7A2A3D"), hexToOklab("#690228"));
    assert.equal(snapDetectionToCandidates(visionDetection("#7A2A3D"), palette, d / 2).skipped, "too_far");
    assert.equal(snapDetectionToCandidates(visionDetection("#7A2A3D"), palette, d).skipped, null);
  });

  it("passes through detections without a hex and empty palettes", () => {
    const noHex = visionDetection(null);
    assert.deepEqual(snapDetectionToCandidates(noHex, palette), { detection: noHex, snap: null, skipped: "no_hex" });
    const withHex = visionDetection("#7A2A3D");
    assert.deepEqual(snapDetectionToCandidates(withHex, []), { detection: withHex, snap: null, skipped: "no_candidates" });
  });
});

describe("lib/hex-snap — snapDetectionToImage", () => {
  const previousFlag = process.env.HEX_DETECTION_SNAP_ENABLED;
  afterEach(() => {
    if (previousFlag === undefined) delete process.env.HEX_DETECTION_SNAP_ENABLED;
    else process.env.HEX_DETECTION_SNAP_ENABLED = previousFlag;
  });

  it("does nothing (and never loads the image) while the flag is off", async () => {
    delete process.env.HEX_DETECTION_SNAP_ENABLED;
    let loads = 0;
    const input = visionDetection("#112233");
    const out = await snapDetectionToImage(input, async () => {
      loads += 1;
      return solidImage(0x10, 0x20, 0x30);
    });
    assert.equal(out.skipped, "disabled");
    assert.equal(out.detection, input);
    assert.equal(loads, 0);
  });

  it("snaps to the color measured from the image when enabled", async () => {
    process.env.HEX_DETECTION_SNAP_ENABLED = "true";
    const logs = [];
    const out = await snapDetectionToImage(visionDetection("#112233"), () => solidImage(0x10, 0x20, 0x30), {
      label: "p1",
      onLog: (level, message, data) => logs.push({ level, message, data }),
    });
    assert.equal(out.skipped, null);
    assert.equal(out.detection.hex, "#102030");
    assert.equal(out.detection.method, "vision-snap");
    assert.equal(out.detection.confidence, 0.8);
    assert.ok(out.snap.snapDistance <= DEFAULT_HEX_SNAP_MAX_DISTANCE);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].level, "info");
    assert.match(logs[0].message, /\[hex-snap\] p1 Snapped/);
    assert.equal(logs[0].data.modelHex, "#112233");
    assert.equal(logs[0].data.hex, "#102030");
  });

  it("the enabled option overrides the environment flag in both directions", async () => {
    delete process.env.HEX_DETECTION_SNAP_ENABLED;
    const on = await snapDetectionToImage(visionDetection("#112233"), () => solidImage(0x10, 0x20, 0x30), { enabled: true });
    assert.equal(on.detection.hex, "#102030");
    process.env.HEX_DETECTION_SNAP_ENABLED = "true";
    const off = await snapDetectionToImage(visionDetection("#112233"), () => solidImage(0x10, 0x20, 0x30), { enabled: false });
    assert.equal(off.skipped, "disabled");
  });

  it("keeps the model hex when the image is too different from it", async () => {
    process.env.HEX_DETECTION_SNAP_ENABLED = "true";
    const input = visionDetection("#112233");
    const out = await snapDetectionToImage(input, () => solidImage(0xf4, 0xf4, 0xf4));
    assert.equal(out.skipped, "too_far");
    assert.equal(out.detection.hex, "#112233");
    assert.equal(out.detection.method, "vision-direct");
  });

  it("keeps the model hex when the image cannot be loaded or decoded, and reports it", async () => {
    process.env.HEX_DETECTION_SNAP_ENABLED = "true";
    const input = visionDetection("#112233");
    const warnings = [];
    const onLog = (level, message) => level === "warn" && warnings.push(message);

    const failed = await snapDetectionToImage(input, async () => { throw new Error("blob gone"); }, { onLog });
    assert.equal(failed.skipped, "palette_failed");
    assert.equal(failed.detection, input);

    const missing = await snapDetectionToImage(input, async () => null, { onLog });
    assert.equal(missing.skipped, "image_unavailable");
    assert.equal(missing.detection, input);

    const garbage = await snapDetectionToImage(input, async () => Buffer.from("not an image"), { onLog });
    assert.equal(garbage.skipped, "palette_failed");

    assert.equal(warnings.length, 3);
  });

  it("skips detections without a hex before touching the image", async () => {
    process.env.HEX_DETECTION_SNAP_ENABLED = "true";
    let loads = 0;
    const out = await snapDetectionToImage(visionDetection(null), async () => { loads += 1; return null; });
    assert.equal(out.skipped, "no_hex");
    assert.equal(loads, 0);
  });
});
