import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CaptureCheckCandidate, CaptureCheckResponse, CaptureReadSummary, CreateCardEdits, CreateCardModel } from "swatchwatch-shared";
import { EMPTY_STICKY_HINTS } from "swatchwatch-shared";
import type { CheckedVerdict, NearDupeVerdict } from "./capture-verdict";
import {
  bottleAddQuantity,
  bottleEvidence,
  echoMatchesBatch,
  pickRowView,
  readPanelRows,
  surfaceChipStatus,
  verdictAfterBottleAdd,
  verdictAfterCreate,
  verdictFromPickedCandidate,
  viewForSurface,
} from "./bottle-rapid-add";

function candidate(overrides: Partial<CaptureCheckCandidate> = {}): CaptureCheckCandidate {
  return {
    entityType: "shade",
    entityId: "7",
    shadeId: "7",
    display: "Loud Lacquer — Pixie Dust",
    confidence: 0.874,
    ownership: { relationship: "notOwned" },
    ...overrides,
  };
}

function check(overrides: Partial<CaptureCheckResponse> = {}): CaptureCheckResponse {
  return {
    captureId: "c1",
    status: "processing",
    outcome: "needs_question",
    confidence: 0.4,
    candidates: [],
    ...overrides,
  };
}

describe("bottleEvidence", () => {
  it("collects the suggested brand, shade and the scanned gtin without empty keys", () => {
    const evidence = bottleEvidence(
      check({
        suggestedShade: {
          brandId: null,
          brandName: "Loud Lacquer",
          brandSource: "read",
          shadeName: null,
          hex: null,
          finish: null,
          gtin: null,
        },
      }),
      "4006381333931",
    );
    assert.deepEqual(evidence, { gtin: "4006381333931", brand: "Loud Lacquer" });
    assert.deepEqual(bottleEvidence(check()), {});
  });
});

describe("viewForSurface", () => {
  const base = {
    surface: "bottom" as const,
    frameType: "label" as const,
    prompt: "Now the bottom",
    hint: null,
    reason: null,
    optional: false,
    step: 2,
    total: 3,
  };

  it("keeps the server view for the same surface", () => {
    assert.equal(viewForSurface("bottom", base), base);
  });

  it("builds a default view for another surface and keeps the step counter", () => {
    const view = viewForSurface("glass", base);
    assert.equal(view.surface, "glass");
    assert.equal(view.frameType, "color");
    assert.equal(view.prompt, "Turn it so we see the color");
    assert.equal(view.step, 2);
    assert.equal(viewForSurface("box", null).optional, true);
  });
});

describe("surfaceChipStatus", () => {
  it("reports captured, skipped and open", () => {
    assert.equal(surfaceChipStatus("front", ["front"], []), "captured");
    assert.equal(surfaceChipStatus("bottom", ["front"], ["bottom"]), "skipped");
    assert.equal(surfaceChipStatus("glass", ["front"], ["bottom"]), "open");
  });
});

describe("pickRowView", () => {
  it("formats confidence, color distance and ownership", () => {
    const row = pickRowView(
      candidate({ hex: "#112233", colorDistance: 0.0412, ownership: { relationship: "owned", quantity: 2 } }),
      null,
    );
    assert.equal(row.confidenceLabel, "87% match");
    assert.equal(row.colorDeltaLabel, "Δ color 0.04");
    assert.equal(row.ownershipLabel, "Owned × 2");
    assert.equal(row.hex, "#112233");
    assert.equal(row.brandName, null);
  });

  it("omits the color delta when the glass photo gave none and labels a wishlist row", () => {
    const row = pickRowView(candidate({ ownership: { relationship: "wishlisted" } }), null);
    assert.equal(row.colorDeltaLabel, null);
    assert.equal(row.ownershipLabel, "On wishlist");
    assert.equal(pickRowView(candidate(), null).ownershipLabel, null);
  });

  it("names the brand only while the brands disagree", () => {
    const conflict = {
      hinted: { brandId: "1", name: "OPI", source: "hint" as const },
      read: { brandId: "2", name: "Loud Lacquer", source: "read" as const },
    };
    assert.equal(pickRowView(candidate({ brandId: "2" }), conflict).brandName, "Loud Lacquer");
    assert.equal(pickRowView(candidate({ brandId: "1" }), conflict).brandName, "OPI");
    assert.equal(pickRowView(candidate({ brandId: "3" }), conflict).brandName, null);
    assert.equal(pickRowView(candidate({ brandId: "2" }), null).brandName, null);
  });
});

describe("verdictFromPickedCandidate", () => {
  it("turns the picked candidate into a checked verdict", () => {
    const verdict = verdictFromPickedCandidate(check(), candidate({ hex: "#112233" }));
    assert.equal(verdict?.kind, "checked");
    if (verdict?.kind === "checked") {
      assert.equal(verdict.shadeId, "7");
      assert.equal(verdict.relationship, "notOwned");
      assert.equal(verdict.hex, "#112233");
    }
  });
});

describe("bottle add verdicts", () => {
  const owned: CheckedVerdict = {
    kind: "checked",
    relationship: "owned",
    display: "Loud Lacquer — Pixie Dust",
    shadeId: "7",
    quantity: 2,
    gtin: "",
  };
  const fresh: CheckedVerdict = { ...owned, relationship: "notOwned", quantity: undefined };

  it("writes one more bottle for an owned shade, else one", () => {
    assert.equal(bottleAddQuantity(owned), 3);
    assert.equal(bottleAddQuantity(fresh), 1);
    assert.equal(bottleAddQuantity({ ...owned, relationship: "wishlisted" }), 1);
  });

  it("answers an owned add with the counted-another verdict that can be undone", () => {
    const verdict = verdictAfterBottleAdd(owned, "55");
    assert.equal(verdict.kind, "owned");
    if (verdict.kind === "owned") {
      assert.equal(verdict.previousQuantity, 2);
      assert.equal(verdict.quantity, 3);
      assert.equal(verdict.inventoryItemId, "55");
    }
  });

  it("answers a new add as added, and a wishlist purchase as matched", () => {
    const added = verdictAfterBottleAdd(fresh, "55");
    assert.deepEqual(added, {
      kind: "added",
      display: "Loud Lacquer — Pixie Dust",
      inventoryItemId: "55",
      shadeId: "7",
      priorOwnership: "none",
    });
    assert.equal(
      (verdictAfterBottleAdd({ ...owned, relationship: "wishlisted" }, undefined) as { priorOwnership: string })
        .priorOwnership,
      "unknown",
    );
  });

  it("treats a near-dupe add as a new shade", () => {
    const dupe = { kind: "near_dupe", display: "A — B", shadeId: "9", gtin: "" } as unknown as NearDupeVerdict;
    assert.equal(bottleAddQuantity(dupe), 1);
    assert.equal(verdictAfterBottleAdd(dupe, undefined).kind, "added");
  });
});

describe("verdictAfterCreate", () => {
  const card: CreateCardModel = {
    captureId: "c1",
    brand: "Loud Lacquer",
    brandSource: "read",
    brandNeedsConfirm: true,
    shadeName: "Pixie Dust",
    hex: "#aabbcc",
    finish: "shimmer",
    gtin: "4006381333931",
  };
  const edits: CreateCardEdits = {
    brand: " Loud Lacquer ",
    shadeName: "Pixie Dust ",
    hex: "#aabbcc",
    finish: "shimmer",
    brandConfirmed: true,
  };

  it("shows the added verdict for an owned create", () => {
    assert.deepEqual(verdictAfterCreate({ id: "12", inventoryItemId: "40" }, card, edits, "owned"), {
      kind: "added",
      display: "Loud Lacquer — Pixie Dust",
      shadeId: "12",
      inventoryItemId: "40",
      priorOwnership: "none",
    });
  });

  it("shows a wishlisted card for a wishlist create", () => {
    const verdict = verdictAfterCreate({ id: "12" }, card, edits, "wishlist");
    assert.equal(verdict.kind, "checked");
    if (verdict.kind === "checked") {
      assert.equal(verdict.relationship, "wishlisted");
      assert.equal(verdict.wishlistedNow, true);
      assert.equal(verdict.gtin, "4006381333931");
      assert.equal(verdict.hex, "#aabbcc");
    }
  });
});

describe("echoMatchesBatch", () => {
  const hints = { ...EMPTY_STICKY_HINTS, brand: "loud", brandCanonical: "Loud Lacquer", brandId: "9" };

  it("accepts an echo of the typed or the canonical brand, ignoring case", () => {
    assert.equal(echoMatchesBatch(hints, { raw: "Loud", brandId: "9", name: "Loud Lacquer" }), true);
    assert.equal(echoMatchesBatch(hints, { raw: "loud lacquer", brandId: "9", name: "Loud Lacquer" }), true);
  });

  it("rejects an echo for a brand the batch no longer has", () => {
    assert.equal(echoMatchesBatch(hints, { raw: "OPI", brandId: "1", name: "OPI" }), false);
    assert.equal(echoMatchesBatch(EMPTY_STICKY_HINTS, { raw: "OPI", brandId: "1", name: "OPI" }), false);
  });
});

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
