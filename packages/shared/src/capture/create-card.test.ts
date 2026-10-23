import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CaptureCheckCandidate, CaptureSuggestedShade } from "../types/capture";
import {
  canSubmitCreateCard,
  createPolishRequestFromCard,
  deriveCreateCard,
  type CreateCardEdits,
  type CreateCardModel,
} from "./create-card";

const suggestion: CaptureSuggestedShade = {
  brandId: null,
  brandName: "Loud Lacquer",
  brandSource: "read",
  shadeName: "Pink Thing",
  hex: "#E0457B",
  finish: "creme",
  gtin: "4006381333931",
};

function candidate(id: string): CaptureCheckCandidate {
  return {
    entityType: "shade",
    entityId: id,
    shadeId: id,
    display: `Shade ${id}`,
    confidence: 0.5,
    ownership: { relationship: "notOwned" },
  };
}

const unmatched = {
  captureId: "cap-1",
  outcome: "unmatched" as const,
  candidates: [] as CaptureCheckCandidate[],
  suggestedShade: suggestion,
};

describe("deriveCreateCard", () => {
  it("is null when the check matched", () => {
    assert.equal(
      deriveCreateCard({ ...unmatched, outcome: "matched", candidates: [candidate("1")] }, { afterNoneOfThese: false }),
      null,
    );
  });

  it("hides behind visible candidates until the user says none of these", () => {
    const check = { ...unmatched, outcome: "needs_question" as const, candidates: [candidate("1"), candidate("2")] };
    assert.equal(deriveCreateCard(check, { afterNoneOfThese: false }), null);
    const card = deriveCreateCard(check, { afterNoneOfThese: true });
    assert.ok(card);
    assert.equal(card.shadeName, "Pink Thing");
  });

  it("is null without a suggestedShade", () => {
    assert.equal(deriveCreateCard({ ...unmatched, suggestedShade: undefined }, { afterNoneOfThese: false }), null);
  });

  it("builds a card from an unmatched check and flags a read brand for confirmation", () => {
    assert.deepEqual(deriveCreateCard(unmatched, { afterNoneOfThese: false }), {
      captureId: "cap-1",
      brand: "Loud Lacquer",
      brandSource: "read",
      brandNeedsConfirm: true,
      shadeName: "Pink Thing",
      hex: "#E0457B",
      finish: "creme",
      gtin: "4006381333931",
    });
  });

  it("does not ask to confirm a hinted or barcode brand, and fills blanks with empty strings", () => {
    const card = deriveCreateCard(
      { ...unmatched, suggestedShade: { ...suggestion, brandSource: "hint", shadeName: null, brandName: null } },
      { afterNoneOfThese: false },
    );
    assert.ok(card);
    assert.equal(card.brandNeedsConfirm, false);
    assert.equal(card.brand, "");
    assert.equal(card.shadeName, "");
  });
});

describe("canSubmitCreateCard", () => {
  const card = deriveCreateCard(unmatched, { afterNoneOfThese: false }) as CreateCardModel;
  const edits: CreateCardEdits = {
    brand: "Loud Lacquer",
    shadeName: "Pink Thing",
    hex: "#E0457B",
    finish: "creme",
    brandConfirmed: false,
  };

  it("needs the read brand confirmed or edited", () => {
    assert.equal(canSubmitCreateCard(card, edits), false);
    assert.equal(canSubmitCreateCard(card, { ...edits, brandConfirmed: true }), true);
    assert.equal(canSubmitCreateCard(card, { ...edits, brand: "Loud Lacquers" }), true);
  });

  it("needs a brand and a shade name", () => {
    const confirmed = { ...edits, brandConfirmed: true };
    assert.equal(canSubmitCreateCard(card, { ...confirmed, brand: "  " }), false);
    assert.equal(canSubmitCreateCard(card, { ...confirmed, shadeName: "" }), false);
  });

  it("does not need confirmation for a trusted brand", () => {
    const trusted = { ...card, brandSource: "hint" as const, brandNeedsConfirm: false };
    assert.equal(canSubmitCreateCard(trusted, edits), true);
  });
});

describe("createPolishRequestFromCard", () => {
  const card = deriveCreateCard(unmatched, { afterNoneOfThese: false }) as CreateCardModel;
  const edits: CreateCardEdits = {
    brand: "  Loud Lacquer ",
    shadeName: " Pink Thing  ",
    hex: "#E0457B",
    finish: "creme",
    brandConfirmed: true,
  };

  it("builds an owned create request", () => {
    assert.deepEqual(createPolishRequestFromCard(card, edits, "owned"), {
      brand: "Loud Lacquer",
      name: "Pink Thing",
      color: "pink",
      detectedHex: "#E0457B",
      finishes: ["creme"],
      barcode: "4006381333931",
      captureId: "cap-1",
      status: "owned",
      quantity: 1,
    });
  });

  it("uses quantity 0 for the wishlist", () => {
    const request = createPolishRequestFromCard(card, edits, "wishlist");
    assert.equal(request.status, "wishlist");
    assert.equal(request.quantity, 0);
  });

  it("falls back to unknown color and omits optional keys", () => {
    const request = createPolishRequestFromCard({ ...card, gtin: null }, { ...edits, hex: null, finish: null }, "owned");
    assert.equal(request.color, "unknown");
    assert.ok(!("detectedHex" in request));
    assert.ok(!("finishes" in request));
    assert.ok(!("barcode" in request));
  });
});
