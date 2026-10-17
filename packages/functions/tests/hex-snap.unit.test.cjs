const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  snapHexToPalette,
  resolveHexSnapMaxDistance,
  DEFAULT_HEX_SNAP_MAX_DISTANCE,
} = require("../dist/lib/hex-snap");
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
