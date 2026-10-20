import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CaptureCheckCandidate, CaptureCheckResponse, PolishDupesResponse } from "swatchwatch-shared";
import {
  buildStartMetadata,
  canCheck,
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
