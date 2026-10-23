import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CaptureCheckCandidate, CaptureCheckResponse, PolishDupesResponse } from "swatchwatch-shared";
import {
  buildFrameQuality,
  buildStartMetadata,
  candidateBrandBadge,
  canCheck,
  createdCandidate,
  deriveBottleVerdict,
  deriveVerdict,
  framesReducer,
  isRetryableStatus,
  MAX_CAPTURE_FRAMES,
  normalizeNativeBarcode,
  summarizeFrames,
  verdictForCandidate,
  withDupes,
  type CaptureFrameEntry,
} from "./rapid-add";

function candidate(relationship: "owned" | "wishlisted" | "notOwned", extra: Partial<CaptureCheckCandidate> = {}): CaptureCheckCandidate {
  return {
    entityType: "shade",
    entityId: "42",
    shadeId: "42",
    display: "OPI — Big Apple Red",
    confidence: 0.93,
    ownership: relationship === "owned" ? { relationship, quantity: 2 } : { relationship },
    ...extra,
  };
}

function check(partial: Partial<CaptureCheckResponse>): CaptureCheckResponse {
  return { captureId: "c", status: "processing", outcome: "unmatched", confidence: 0, candidates: [], ...partial };
}

const frame = (localId: string) => ({ localId, frameType: "label" as const, dataUrl: "data:image/jpeg;base64,AA", quality: {} });

describe("normalizeNativeBarcode", () => {
  it("reports iOS's 0-prefixed EAN-13 as the printed 12-digit UPC-A", () => {
    assert.deepEqual(normalizeNativeBarcode({ type: "ean13", data: "0036000291452" }), {
      gtin: "036000291452",
      format: "upc_a",
      engine: "expo-camera",
    });
  });

  it("keeps a real EAN-13 as is", () => {
    assert.deepEqual(normalizeNativeBarcode({ type: "ean13", data: "4006381333931" }), {
      gtin: "4006381333931",
      format: "ean_13",
      engine: "expo-camera",
    });
  });

  it("rejects a bad check digit and non-retail formats", () => {
    assert.equal(normalizeNativeBarcode({ type: "ean13", data: "4006381333932" }), null);
    assert.equal(normalizeNativeBarcode({ type: "qr", data: "https://example.com" }), null);
  });

  it("accepts Android's upc_a spelling", () => {
    assert.equal(normalizeNativeBarcode({ type: "upc_a", data: "036000291452" })?.format, "upc_a");
  });
});

describe("framesReducer", () => {
  it("caps a scan at MAX_CAPTURE_FRAMES", () => {
    let state: CaptureFrameEntry[] = [];
    for (let i = 0; i < MAX_CAPTURE_FRAMES + 2; i += 1) state = framesReducer(state, { type: "added", frame: frame(String(i)) });
    assert.equal(state.length, MAX_CAPTURE_FRAMES);
  });

  it("keeps a failed frame until retried, counting attempts", () => {
    let state = framesReducer([], { type: "added", frame: frame("a") });
    state = framesReducer(state, { type: "upload_failed", localId: "a", error: "boom" });
    assert.equal(state[0].status, "failed");
    state = framesReducer(state, { type: "upload_started", localId: "a" });
    assert.equal(state[0].status, "uploading");
    assert.equal(state[0].attempts, 2);
    state = framesReducer(state, { type: "upload_succeeded", localId: "a", frameId: "f1" });
    assert.deepEqual(summarizeFrames(state), { total: 1, uploading: 0, uploaded: 1, failed: 0 });
  });

  it("only removes failed frames", () => {
    let state = framesReducer([], { type: "added", frame: frame("a") });
    state = framesReducer(state, { type: "removed", localId: "a" });
    assert.equal(state.length, 1);
    state = framesReducer(state, { type: "upload_failed", localId: "a", error: "x" });
    assert.equal(framesReducer(state, { type: "removed", localId: "a" }).length, 0);
  });
});

describe("canCheck", () => {
  it("waits for uploads and needs some evidence", () => {
    const uploading = framesReducer([], { type: "added", frame: frame("a") });
    assert.equal(canCheck({ frames: [], hasBarcode: false, hasHints: false, busy: false }), false);
    assert.equal(canCheck({ frames: [], hasBarcode: false, hasHints: true, busy: false }), true);
    assert.equal(canCheck({ frames: uploading, hasBarcode: true, hasHints: false, busy: false }), false);
    assert.equal(canCheck({ frames: [], hasBarcode: true, hasHints: false, busy: true }), false);
  });
});

describe("isRetryableStatus", () => {
  it("retries network, timeout, throttling and server errors only", () => {
    assert.deepEqual([0, 408, 429, 500, 503, 400, 401, 413].map(isRetryableStatus), [true, true, true, true, true, false, false, false]);
  });
});

describe("buildStartMetadata", () => {
  it("tags the source and carries the barcode and trimmed hints", () => {
    assert.deepEqual(
      buildStartMetadata({
        barcode: { gtin: "036000291452", format: "upc_a", engine: "expo-camera" },
        hints: { brand: "  OPI ", shadeName: "" },
      }),
      { source: "mobile-rapid-add", brand: "OPI", gtin: "036000291452", barcodeFormat: "upc_a", barcodeDecoder: "expo-camera" },
    );
  });
});

describe("verdicts", () => {
  it("maps ownership to owned / wishlisted / add without writing anything", () => {
    assert.deepEqual(verdictForCandidate(candidate("owned")), { kind: "owned", candidate: candidate("owned"), quantity: 2 });
    assert.equal(verdictForCandidate(candidate("wishlisted")).kind, "wishlisted");
    assert.equal(verdictForCandidate(candidate("notOwned")).kind, "add");
  });

  it("offers candidates on needs_question and not-found on unmatched", () => {
    const many = [candidate("notOwned"), candidate("owned", { entityId: "7", shadeId: "7" })];
    assert.deepEqual(deriveVerdict(check({ outcome: "needs_question", candidates: many })), { kind: "pick", candidates: many });
    assert.deepEqual(deriveVerdict(check({ outcome: "unmatched" }), "123"), { kind: "not-found", gtin: "123" });
    // SKU candidates without a catalog shade can't be added exactly, so they aren't offered.
    const sku = candidate("notOwned", { entityType: "sku", entityId: "9", shadeId: null });
    assert.deepEqual(deriveVerdict(check({ outcome: "needs_question", candidates: [sku, many[0]] })), { kind: "pick", candidates: [many[0]] });
    assert.deepEqual(deriveVerdict(check({ outcome: "needs_question", candidates: [sku] }), "5"), { kind: "not-found", gtin: "5" });
    assert.equal(deriveVerdict(check({ outcome: "matched", match: candidate("owned") })).kind, "owned");
  });

  it("upgrades a new shade to near-dupe only when an owned dupe exists", () => {
    const add = verdictForCandidate(candidate("notOwned"));
    const none = { dupeCount: 0, dupes: [] } as unknown as PolishDupesResponse;
    const some = { dupeCount: 1, highCount: 1, dupes: [] } as unknown as PolishDupesResponse;
    assert.equal(withDupes(add, null).kind, "add");
    assert.equal(withDupes(add, none).kind, "add");
    assert.equal(withDupes(add, some).kind, "near-dupe");
    assert.equal(withDupes(verdictForCandidate(candidate("owned")), some).kind, "owned");
  });
});

describe("buildFrameQuality surface", () => {
  const base = { source: "mobile-camera" as const, width: 1, height: 2, sourceWidth: 3, sourceHeight: 4 };

  it("tags the bottle surface when given", () => {
    assert.equal(buildFrameQuality({ ...base, surface: "bottom" }).surface, "bottom");
  });

  it("omits the surface key when absent or null", () => {
    assert.ok(!("surface" in buildFrameQuality(base)));
    assert.ok(!("surface" in buildFrameQuality({ ...base, surface: null })));
  });
});

describe("buildStartMetadata sticky hints", () => {
  const sticky = { brand: "Loud", brandCanonical: "Loud Lacquer", brandId: "7", finish: "creme", collection: "Fall" };

  it("fills brand, finish and collection from the sticky hints", () => {
    assert.deepEqual(buildStartMetadata({ barcode: null, hints: {}, sticky }), {
      source: "mobile-rapid-add",
      brand: "Loud Lacquer",
      finish: "creme",
      collection: "Fall",
    });
  });

  it("lets a typed hint win over the sticky brand", () => {
    const metadata = buildStartMetadata({ barcode: null, hints: { brand: "OPI" }, sticky });
    assert.equal(metadata.brand, "OPI");
    assert.equal(metadata.finish, "creme");
  });

  it("is unchanged without sticky hints", () => {
    assert.deepEqual(buildStartMetadata({ barcode: null, hints: {}, sticky: null }), { source: "mobile-rapid-add" });
  });
});

describe("deriveBottleVerdict", () => {
  const conflict = {
    hinted: { brandId: "1", name: "OPI", source: "hint" as const },
    read: { brandId: "2", name: "Essie", source: "read" as const },
  };
  const suggestedShade = {
    brandId: "2",
    brandName: "Essie",
    brandSource: "read" as const,
    shadeName: "Ballet Slippers",
    hex: "#F5D7DC",
    finish: "creme",
    gtin: null,
  };

  it("maps a match through its ownership", () => {
    assert.equal(deriveBottleVerdict(check({ outcome: "matched", match: candidate("owned") }), { afterNoneOfThese: false }).kind, "owned");
    assert.equal(deriveBottleVerdict(check({ outcome: "matched", match: candidate("notOwned") }), { afterNoneOfThese: false }).kind, "add");
  });

  it("offers pickable candidates and carries the brand conflict", () => {
    const many = [candidate("notOwned"), candidate("owned", { entityId: "7", shadeId: "7" })];
    assert.deepEqual(
      deriveBottleVerdict(check({ outcome: "needs_question", candidates: many, brandConflict: conflict }), { afterNoneOfThese: false }),
      { kind: "pick", candidates: many, brandConflict: conflict },
    );
  });

  it("shows the create card after None of these, with the capture id", () => {
    const many = [candidate("notOwned")];
    const verdict = deriveBottleVerdict(
      check({ captureId: "cap-9", outcome: "needs_question", candidates: many, suggestedShade, brandConflict: conflict }),
      { afterNoneOfThese: true },
    );
    assert.equal(verdict.kind, "create");
    if (verdict.kind !== "create") return;
    assert.equal(verdict.card.captureId, "cap-9");
    assert.equal(verdict.card.brand, "Essie");
    assert.deepEqual(verdict.brandConflict, conflict);
  });

  it("creates directly from an unmatched bottle with a suggestion", () => {
    const verdict = deriveBottleVerdict(check({ captureId: "cap-1", outcome: "unmatched", suggestedShade }), { afterNoneOfThese: false });
    assert.equal(verdict.kind, "create");
    if (verdict.kind === "create") assert.equal(verdict.brandConflict, null);
  });

  it("falls back to not-found with the gtin when there is nothing to prefill", () => {
    assert.deepEqual(deriveBottleVerdict(check({ outcome: "unmatched" }), { afterNoneOfThese: false, gtin: "123" }), { kind: "not-found", gtin: "123" });
  });
});

describe("candidateBrandBadge", () => {
  const conflict = {
    hinted: { brandId: "1", name: "OPI", source: "hint" as const },
    read: { brandId: "2", name: "Essie", source: "read" as const },
  };

  it("names the brand a candidate belongs to when the hint and the bottle disagree", () => {
    assert.deepEqual(candidateBrandBadge({ brandId: "2" }, conflict), { source: "bottle", name: "Essie" });
    assert.deepEqual(candidateBrandBadge({ brandId: "1" }, conflict), { source: "typed", name: "OPI" });
  });

  it("is null without a conflict, without a brand id or for another brand", () => {
    assert.equal(candidateBrandBadge({ brandId: "2" }, null), null);
    assert.equal(candidateBrandBadge({ brandId: undefined }, conflict), null);
    assert.equal(candidateBrandBadge({ brandId: "9" }, conflict), null);
  });
});

describe("createdCandidate", () => {
  it("describes an owned polish the create card made", () => {
    assert.deepEqual(createdCandidate({ id: "7", brand: "Essie", name: "Ballet Slippers" }, "owned", "#F7C8D0"), {
      entityType: "shade",
      entityId: "7",
      shadeId: "7",
      display: "Essie — Ballet Slippers",
      confidence: 1,
      ownership: { relationship: "owned", quantity: 1 },
      hex: "#F7C8D0",
    });
  });

  it("marks a wishlist add without a hex", () => {
    const candidate = createdCandidate({ id: "7", brand: "Essie", name: "Ballet Slippers" }, "wishlist", null);
    assert.deepEqual(candidate.ownership, { relationship: "wishlisted" });
    assert.equal("hex" in candidate, false);
  });
});
