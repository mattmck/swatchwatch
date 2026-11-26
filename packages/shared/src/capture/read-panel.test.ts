import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CaptureReadSummary } from "../types/capture";
import { readPanelRows } from "./read-panel";

describe("readPanelRows", () => {
  const summary: CaptureReadSummary = {
    gtin: "4006381333931",
    brand: { name: "Holo Taco", source: "read", catalogMatch: true },
    shadeName: "Unicorn Skn",
    shadeNameListed: "Unicorn Skin",
    hex: "#C8A2D6",
    finish: "holographic",
    newFields: ["shadeName", "hex"],
  };
  const byField = (rows: ReturnType<typeof readPanelRows>) => Object.fromEntries(rows.map((r) => [r.field, r]));

  it("lists barcode, brand, shade name, color and finish in that order", () => {
    assert.deepEqual(readPanelRows(summary, null).map((r) => r.label), ["Barcode", "Brand", "Shade name", "Color", "Finish"]);
  });

  it("shows each value, marks what the latest photo added, and names the catalog pick", () => {
    const rows = byField(readPanelRows(summary, null));
    assert.equal(rows.gtin.value, "4006381333931");
    assert.equal(rows.brand.value, "Holo Taco");
    assert.equal(rows.brand.detail, "Matched in the catalog");
    assert.equal(rows.shadeName.value, "Unicorn Skn");
    assert.equal(rows.shadeName.detail, "Closest catalog name: Unicorn Skin");
    assert.equal(rows.hex.hex, "#C8A2D6");
    assert.deepEqual(
      Object.values(rows).filter((r) => r.isNew).map((r) => r.field),
      ["shadeName", "hex"],
    );
  });

  it("nothing read: every value null; a barcode read on the device shows before the server answers", () => {
    assert.ok(readPanelRows(null, null).every((r) => r.value === null && !r.isNew));
    const live = byField(readPanelRows(null, "4006381333931"));
    assert.equal(live.gtin.value, "4006381333931");
    assert.equal(live.gtin.detail, "Scanned on this device");
  });

  it("a brand read off the bottle that matched no catalog brand asks to be checked; a typed one does not", () => {
    const read = byField(readPanelRows({ ...summary, brand: { name: "Loud", source: "read", catalogMatch: false } }, null));
    assert.equal(read.brand.needsCheck, true);
    assert.equal(read.brand.detail, "Read from the bottle — check it");
    const typed = byField(readPanelRows({ ...summary, brand: { name: "Loud", source: "hint", catalogMatch: false } }, null));
    assert.equal(typed.brand.needsCheck, false);
    assert.equal(typed.brand.detail, "Your brand (not in the catalog yet)");
  });

  it("a listed pick alone is the shade name", () => {
    const rows = byField(readPanelRows({ ...summary, shadeName: null }, null));
    assert.equal(rows.shadeName.value, "Unicorn Skin");
    assert.equal(rows.shadeName.detail, "Matched to the brand's catalog list");
  });
});
