import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CaptureCheckCandidate, CaptureCheckResponse, CreateCardEdits, CreateCardModel } from "swatchwatch-shared";
import type { CheckedVerdict, NearDupeVerdict } from "./capture-verdict";
import {
  bottleAddQuantity,
  bottleEvidence,
  pickRowView,
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
