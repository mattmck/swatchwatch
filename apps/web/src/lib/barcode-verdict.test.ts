import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CaptureCheckCandidate, CaptureCheckResponse } from "swatchwatch-shared";
import { manualAddHref, scanPrefillFromParams, verdictFromCheck } from "./capture-verdict";
import { ownedEntryAfterVerdict } from "./capture-verdict";

const scanned = { gtin: "0036000291452", format: "upc_a" as const };

function candidate(overrides: Partial<CaptureCheckCandidate> = {}): CaptureCheckCandidate {
  return {
    entityType: "sku",
    entityId: "501",
    shadeId: "21",
    display: "Holo Taco — Blurple",
    confidence: 1,
    ownership: { relationship: "notOwned" },
    hex: "#5B4BD6",
    ...overrides,
  };
}

function check(overrides: Partial<CaptureCheckResponse> = {}): CaptureCheckResponse {
  const match = "match" in overrides ? overrides.match : candidate();
  return {
    captureId: "c1",
    status: "processing",
    outcome: "matched",
    confidence: 1,
    candidates: match ? [match] : [],
    ...overrides,
    match,
  };
}

describe("verdictFromCheck — a scanned barcode's verdict", () => {
  it("a match the user doesn't have offers to add it, with brand/shade and swatch", () => {
    assert.deepEqual(verdictFromCheck(check(), scanned), {
      kind: "checked",
      relationship: "notOwned",
      display: "Holo Taco — Blurple",
      shadeId: "21",
      hex: "#5B4BD6",
      gtin: "0036000291452",
    });
  });

  it("an owned match says so with the bottle count", () => {
    const verdict = verdictFromCheck(
      check({ match: candidate({ ownership: { relationship: "owned", quantity: 2 } }) }),
      scanned,
    );
    assert.equal(verdict?.kind, "checked");
    assert.equal(verdict?.kind === "checked" && verdict.relationship, "owned");
    assert.equal(verdict?.kind === "checked" && verdict.quantity, 2);
  });

  it("a wishlisted match is reported as wishlisted", () => {
    const verdict = verdictFromCheck(
      check({ match: candidate({ ownership: { relationship: "wishlisted" } }) }),
      scanned,
    );
    assert.equal(verdict?.kind === "checked" && verdict.relationship, "wishlisted");
  });

  it("a barcode that matches nothing is an unknown barcode, whatever the resolver asks next", () => {
    for (const outcome of ["unmatched", "needs_question"] as const) {
      assert.deepEqual(verdictFromCheck(check({ outcome, match: undefined, confidence: 0 }), scanned), {
        kind: "unknown_barcode",
        gtin: "0036000291452",
        format: "upc_a",
      });
    }
  });

  it("without a scanned barcode an unmatched check is not a verdict yet", () => {
    assert.equal(verdictFromCheck(check({ outcome: "needs_question", match: undefined }), null), null);
  });

  it("check verdicts never feed the owned snapshot (nothing was added)", () => {
    const verdict = verdictFromCheck(check(), scanned);
    assert.ok(verdict);
    assert.equal(ownedEntryAfterVerdict(verdict), null);
    assert.equal(ownedEntryAfterVerdict({ kind: "unknown_barcode", gtin: "1" }), null);
  });
});

describe("manualAddHref", () => {
  it("carries the scanned barcode and any known names to the add form", () => {
    assert.equal(
      manualAddHref({ gtin: "0036000291452", format: "upc_a", brand: "Holo Taco", shadeName: "Blurple" }),
      "/polishes/new?barcode=0036000291452&barcodeFormat=upc_a&brand=Holo+Taco&name=Blurple",
    );
  });

  it("is the plain form without evidence", () => {
    assert.equal(manualAddHref({}), "/polishes/new");
  });
});

describe("scanPrefillFromParams", () => {
  it("reads back what manualAddHref wrote", () => {
    const href = manualAddHref({ gtin: "0036000291452", format: "upc_a", brand: "Holo Taco", shadeName: "Blurple" });
    const params = new URL(href, "https://example.test").searchParams;
    assert.deepEqual(scanPrefillFromParams(params), {
      barcode: "0036000291452",
      barcodeFormat: "upc_a",
      brand: "Holo Taco",
      name: "Blurple",
    });
  });

  it("ignores a barcode that is not digits", () => {
    assert.deepEqual(scanPrefillFromParams(new URLSearchParams("barcode=<script>&brand=OPI")), { brand: "OPI" });
  });
});
