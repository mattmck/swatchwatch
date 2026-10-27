/**
 * Capture evidence collection (lib/capture-evidence.ts): pure, no database.
 * Covers the legacy evidence rules (request_quality frames, answers.brand_shade
 * precedence) and the bottle-flow additions (brand source, newest frame-read brand,
 * glass hex, per-surface frame counts, skipped surfaces).
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { collectCaptureEvidence, extractFrameEvidence, summarizeCaptureRead } = require(
  path.join(__dirname, "..", "dist", "lib", "capture-evidence.js")
);

const labelFrame = (quality) => ({ frameType: "label", quality });

describe("collectCaptureEvidence", () => {
  it("takes the brand and finish from a front frame but never its shade name or listed pick", () => {
    const front = {
      frameType: "label",
      quality: {
        surface: "front",
        extracted: { brand: "Holo Taco", shadeName: "Rainbow Collection", shadeNameListed: "Unicorn Skin", finish: "holo" },
      },
    };
    const evidence = collectCaptureEvidence({}, [front]);
    assert.equal(evidence.brand, "Holo Taco");
    assert.equal(evidence.finish, "holo");
    assert.equal(evidence.shadeName, undefined);
    assert.equal(evidence.shadeNameListed, undefined);

    const bottom = { frameType: "label", quality: { surface: "bottom", extracted: { shadeName: "Unicorn Skin" } } };
    assert.equal(collectCaptureEvidence({}, [front, bottom]).shadeName, "Unicorn Skin");
    const noSurface = { frameType: "label", quality: { extracted: { shadeName: "Unicorn Skin" } } };
    assert.equal(collectCaptureEvidence({}, [noSurface]).shadeName, "Unicorn Skin", "frames outside the bottle flow are unchanged");
  });

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
    assert.deepEqual(evidence.brandRead, { text: "Holo Taco", confidence: 0.9, source: "pipeline" });
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
    assert.deepEqual(evidence.brandRead, { text: "Newest", confidence: 0.7, source: "pipeline" });
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

  it("a pipeline brand with no confidence is an unscored read, not typed text", () => {
    const evidence = collectCaptureEvidence({}, [labelFrame({ extracted: { brand: "Loud Lacquer" } })]);
    assert.deepEqual(evidence.brandRead, { text: "Loud Lacquer", confidence: 0, source: "pipeline" });
    assert.equal(evidence.brandSource, "read");
  });

  it("a client-sent (request_quality) brand is reported with that source, before and after ingest", () => {
    const legacy = collectCaptureEvidence({}, [labelFrame({ brand: "OPI" })]);
    assert.deepEqual(legacy.brandRead, { text: "OPI", confidence: 0, source: "request_quality" });
    // Ingest stores the client evidence under `extracted` with the server-set source.
    const stored = collectCaptureEvidence({}, [
      labelFrame({ brand: "OPI", extracted: { brand: "OPI", source: "request_quality" } }),
    ]);
    assert.deepEqual(stored.brandRead, { text: "OPI", confidence: 0, source: "request_quality" });
  });

  it("keeps a barcode the device decoded on a bottle photo the pipeline also read", () => {
    // Bottle flow: a bottom photo with its barcode sticker in view stays a label frame (OCR and
    // the sticker read run), and the GTIN decoded on the device is still evidence.
    const evidence = collectCaptureEvidence({}, [
      labelFrame({
        surface: "bottom",
        gtin: "4006381333931",
        barcodeFormat: "ean_13",
        extracted: { brand: "Holo Taco", brandConfidence: 0.9, shadeName: "Unicorn Skin" },
      }),
    ]);
    assert.equal(evidence.gtin, "4006381333931");
    assert.equal(evidence.gtinFormat, "ean_13");
    assert.equal(evidence.shadeName, "Unicorn Skin");
  });

  it("a barcode the pipeline read wins over the device-decoded one", () => {
    const extracted = extractFrameEvidence({
      gtin: "4006381333931",
      extracted: { gtin: "0012345678905", gtinFormat: "upc_a", brand: "OPI" },
    });
    assert.equal(extracted.gtin, "0012345678905");
    assert.equal(extracted.gtinFormat, "upc_a");
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

describe("summarizeCaptureRead", () => {
  const empty = { surfaces: {}, skippedSurfaces: [] };

  it("reports every field read so far and which ones the latest photo added", () => {
    const before = { ...empty, gtin: "4006381333931" };
    const after = {
      ...before,
      brand: "Holo Taco",
      brandSource: "read",
      brandRead: { text: "Holo Taco", confidence: 0.9, source: "pipeline" },
      shadeName: "Unicorn Skn",
      shadeNameListed: "Unicorn Skin",
      glassHex: "#C8A2D6",
      finish: "holographic",
    };
    const brand = { brandId: "7", name: "Holo Taco", source: "read", confidence: 0.9 };
    assert.deepEqual(summarizeCaptureRead(after, brand, before), {
      gtin: "4006381333931",
      brand: { name: "Holo Taco", source: "read", catalogMatch: true },
      shadeName: "Unicorn Skn",
      shadeNameListed: "Unicorn Skin",
      hex: "#C8A2D6",
      finish: "holographic",
      newFields: ["brand", "shadeName", "hex", "finish"],
    });
  });

  it("an unresolved brand is shown as read, with no catalog match", () => {
    const after = { ...empty, brand: "Loud", brandSource: "read", brandRead: { text: "Loud", confidence: 0, source: "pipeline" } };
    assert.deepEqual(summarizeCaptureRead(after, null).brand, { name: "Loud", source: "read", catalogMatch: false });
  });

  it("a typed brand (hint or client text) is a hint", () => {
    const hinted = { ...empty, brand: "Loud", brandSource: "hint" };
    assert.equal(summarizeCaptureRead(hinted, null).brand.source, "hint");
    const typed = { ...empty, brand: "Loud", brandSource: "read", brandRead: { text: "Loud", confidence: 0, source: "request_quality" } };
    assert.equal(summarizeCaptureRead(typed, null).brand.source, "hint");
  });

  it("the resolved brand wins over the raw text, and a hint without a catalog row has no match", () => {
    const after = { ...empty, brand: "loud", brandSource: "hint" };
    const resolved = { brandId: "3", name: "Loud Lacquer", source: "hint" };
    assert.deepEqual(summarizeCaptureRead(after, resolved).brand, { name: "Loud Lacquer", source: "hint", catalogMatch: true });
    const raw = { brandId: null, name: "loud", source: "hint" };
    assert.equal(summarizeCaptureRead(after, raw).brand.catalogMatch, false);
  });

  it("nothing read yet: every field null and no new fields; no `before` means nothing is new", () => {
    assert.deepEqual(summarizeCaptureRead(empty, null), {
      gtin: null, brand: null, shadeName: null, shadeNameListed: null, hex: null, finish: null, newFields: [],
    });
    assert.deepEqual(summarizeCaptureRead({ ...empty, gtin: "4006381333931" }, null).newFields, []);
  });

  it("a listed pick alone counts as a new shade name", () => {
    const after = { ...empty, shadeNameListed: "Unicorn Skin" };
    assert.deepEqual(summarizeCaptureRead(after, null, empty).newFields, ["shadeName"]);
  });
});
