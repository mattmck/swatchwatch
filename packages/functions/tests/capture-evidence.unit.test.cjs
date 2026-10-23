/**
 * Capture evidence collection (lib/capture-evidence.ts): pure, no database.
 * Covers the legacy evidence rules (request_quality frames, answers.brand_shade
 * precedence) and the bottle-flow additions (brand source, newest frame-read brand,
 * glass hex, per-surface frame counts, skipped surfaces).
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { collectCaptureEvidence, extractFrameEvidence } = require(
  path.join(__dirname, "..", "dist", "lib", "capture-evidence.js")
);

const labelFrame = (quality) => ({ frameType: "label", quality });

describe("collectCaptureEvidence", () => {
  it("takes a metadata brand as a hint and reports empty surface state", () => {
    const evidence = collectCaptureEvidence({ brand: "OPI" }, []);
    assert.equal(evidence.brand, "OPI");
    assert.equal(evidence.brandSource, "hint");
    assert.equal(evidence.brandRead, undefined);
    assert.deepEqual(evidence.surfaces, {});
    assert.deepEqual(evidence.skippedSurfaces, []);
  });

  it("reads brand and shade from a pipeline label frame and counts its surface", () => {
    const evidence = collectCaptureEvidence({}, [
      labelFrame({
        surface: "bottom",
        extracted: { brand: "Holo Taco", brandConfidence: 0.9, shadeName: "Unicorn Skin" },
      }),
    ]);
    assert.equal(evidence.brand, "Holo Taco");
    assert.equal(evidence.brandSource, "read");
    assert.deepEqual(evidence.brandRead, { text: "Holo Taco", confidence: 0.9 });
    assert.equal(evidence.shadeName, "Unicorn Skin");
    assert.deepEqual(evidence.surfaces, { bottom: 1 });
  });

  it("keeps the hinted brand but still reports the brand read from the frame", () => {
    const evidence = collectCaptureEvidence({ brand: "OPI" }, [
      labelFrame({
        surface: "bottom",
        extracted: { brand: "Holo Taco", brandConfidence: 0.9 },
      }),
    ]);
    assert.equal(evidence.brand, "OPI");
    assert.equal(evidence.brandSource, "hint");
    assert.equal(evidence.brandRead.text, "Holo Taco");
  });

  it("uses the newest frame's brand read (frames arrive newest first)", () => {
    const evidence = collectCaptureEvidence({}, [
      labelFrame({ extracted: { brand: "Newest", brandConfidence: 0.7 } }),
      labelFrame({ extracted: { brand: "Older", brandConfidence: 0.99 } }),
    ]);
    assert.deepEqual(evidence.brandRead, { text: "Newest", confidence: 0.7 });
  });

  it("accepts a glass hex only from a frame the pipeline marked source glass", () => {
    const glass = collectCaptureEvidence({}, [
      { frameType: "color", quality: { surface: "glass", extracted: { hex: "#AA3366", hexConfidence: 0.8, source: "glass" } } },
    ]);
    assert.equal(glass.glassHex, "#AA3366");
    assert.equal(glass.glassHexConfidence, 0.8);
    assert.deepEqual(glass.surfaces, { glass: 1 });

    const noSource = collectCaptureEvidence({}, [
      { frameType: "color", quality: { surface: "glass", extracted: { hex: "#AA3366", hexConfidence: 0.8 } } },
    ]);
    assert.equal(noSource.glassHex, undefined);
    assert.equal(noSource.glassHexConfidence, undefined);

    const clientSupplied = collectCaptureEvidence({}, [
      { frameType: "color", quality: { surface: "glass", hex: "#AA3366" } },
    ]);
    assert.equal(clientSupplied.glassHex, undefined);
  });

  it("reads a closed-set shade pick from the frame", () => {
    const evidence = collectCaptureEvidence({}, [
      labelFrame({ extracted: { shadeNameListed: "Unicorn Skin" } }),
    ]);
    assert.equal(evidence.shadeNameListed, "Unicorn Skin");
  });

  it("counts only known surfaces", () => {
    const evidence = collectCaptureEvidence({}, [
      labelFrame({ surface: "front" }),
      labelFrame({ surface: "front" }),
      labelFrame({ surface: "cap" }),
      labelFrame({ surface: 7 }),
    ]);
    assert.deepEqual(evidence.surfaces, { front: 2 });
  });

  it("reports skipped surfaces from metadata.bottle.skipped and tolerates garbage", () => {
    assert.deepEqual(
      collectCaptureEvidence({ bottle: { skipped: ["front"] } }, []).skippedSurfaces,
      ["front"]
    );
    assert.deepEqual(
      collectCaptureEvidence({ bottle: { skipped: ["front", "cap", 3] } }, []).skippedSurfaces,
      ["front"]
    );
    assert.deepEqual(collectCaptureEvidence({ bottle: { skipped: "front" } }, []).skippedSurfaces, []);
    assert.deepEqual(collectCaptureEvidence({ bottle: "nope" }, []).skippedSurfaces, []);
  });

  it("reads client-supplied request_quality evidence (legacy frames)", () => {
    const evidence = collectCaptureEvidence({}, [
      labelFrame({ brand: "OPI", shadeName: "Big Apple Red" }),
    ]);
    assert.equal(evidence.brand, "OPI");
    assert.equal(evidence.shadeName, "Big Apple Red");
    assert.equal(
      extractFrameEvidence({ brand: "OPI", shadeName: "Big Apple Red" }).source,
      "request_quality"
    );
  });

  it("prefers answers.brand_shade over top-level metadata", () => {
    const evidence = collectCaptureEvidence(
      {
        brand: "Metadata Brand",
        shadeName: "Metadata Shade",
        answers: { brand_shade: { brand: "OPI", shadeName: "Big Apple Red" } },
      },
      []
    );
    assert.equal(evidence.brand, "OPI");
    assert.equal(evidence.shadeName, "Big Apple Red");
    assert.equal(evidence.brandSource, "hint");
  });
});
