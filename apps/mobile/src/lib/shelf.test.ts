import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CaptureCheckCandidate, PolishDupesResponse } from "swatchwatch-shared";
import type { RapidAddVerdict } from "./rapid-add";
import {
  EMPTY_SHELF,
  formatShelfAge,
  parseShelfEntries,
  SHELF_MAX_ENTRIES,
  shelfCounts,
  shelfEntryFromVerdict,
  shelfQuickActions,
  shelfReducer,
  shelfStatus,
  shelfToStored,
  type ShelfEntry,
  type ShelfState,
} from "./shelf";

function candidate(relationship: "owned" | "wishlisted" | "notOwned", extra: Partial<CaptureCheckCandidate> = {}): CaptureCheckCandidate {
  return {
    entityType: "shade",
    entityId: "42",
    shadeId: "42",
    display: "OPI — Big Apple Red",
    confidence: 0.9,
    hex: "#CC0000",
    ownership: relationship === "owned" ? { relationship, quantity: 2 } : { relationship },
    ...extra,
  };
}

const ctx = { gtin: "036000291452", captureId: "c1", now: 1000 };
const entryFor = (v: RapidAddVerdict, c: { gtin?: string; captureId: string | null; now: number } = ctx) => shelfEntryFromVerdict(v, c) as ShelfEntry;

describe("shelfEntryFromVerdict", () => {
  it("maps each final verdict to a chip and keeps ids, names and hex only", () => {
    const owned = entryFor({ kind: "owned", candidate: candidate("owned"), quantity: 2 });
    assert.deepEqual(owned, {
      key: "gtin:036000291452", gtin: "036000291452", verdict: "owned", display: "OPI — Big Apple Red",
      shadeId: "42", hex: "#CC0000", quantity: 2, firstScannedAt: 1000, lastScannedAt: 1000, scanCount: 1,
    });
    assert.equal(entryFor({ kind: "wishlisted", candidate: candidate("wishlisted") }).verdict, "wishlist");
    assert.equal(entryFor({ kind: "add", candidate: candidate("notOwned") }).verdict, "new");
    const dupes = { dupes: [{ brand: "Essie", name: "Red" }], dupeCount: 1 } as unknown as PolishDupesResponse;
    const near = entryFor({ kind: "near-dupe", candidate: candidate("notOwned"), dupes });
    assert.equal(near.verdict, "near_dupe");
    assert.equal(near.dupeName, "Essie Red");
  });

  it("keys by capture id without a barcode, and skips pick, added and unkeyable verdicts", () => {
    const e = shelfEntryFromVerdict({ kind: "add", candidate: candidate("notOwned") }, { captureId: "c9", now: 1 });
    assert.equal(e?.key, "capture:c9");
    assert.equal(shelfEntryFromVerdict({ kind: "pick", candidates: [] }, ctx), null);
    assert.equal(shelfEntryFromVerdict({ kind: "added", candidate: candidate("notOwned"), status: "owned" }, ctx), null);
    assert.equal(shelfEntryFromVerdict({ kind: "not-found" }, { captureId: null, now: 1 }), null);
  });

  it("not-found carries its gtin and has no quick actions", () => {
    const e = entryFor({ kind: "not-found", gtin: "123" }, { captureId: "c", now: 1 });
    assert.equal(e.key, "gtin:123");
    assert.deepEqual(shelfQuickActions(e), []);
  });
});

describe("shelfReducer", () => {
  const add = (state: ShelfState, key: string, now: number, v: RapidAddVerdict["kind"] = "add") =>
    shelfReducer(state, {
      type: "verdict",
      entry: entryFor(v === "owned" ? { kind: "owned", candidate: candidate("owned"), quantity: 1 } : { kind: "add", candidate: candidate("notOwned") }, {
        gtin: key,
        captureId: "c",
        now,
      }),
    });

  it("keeps the newest first and 'Scan next' keeps the list", () => {
    let s = add(EMPTY_SHELF, "111", 1);
    s = shelfReducer(s, { type: "scan_ended" });
    s = add(s, "222", 2);
    assert.deepEqual(s.entries.map((e) => e.key), ["gtin:222", "gtin:111"]);
    assert.equal(s.repeatKey, null);
  });

  it("flags a repeated GTIN in place instead of appending, keeping first time and actions", () => {
    let s = add(EMPTY_SHELF, "111", 1);
    s = shelfReducer(s, { type: "acted", key: "gtin:111", acted: "wishlisted" });
    s = shelfReducer(s, { type: "scan_ended" });
    s = add(s, "222", 2);
    s = shelfReducer(s, { type: "scan_ended" });
    s = add(s, "111", 3);
    assert.equal(s.entries.length, 2);
    assert.deepEqual(s.entries.map((e) => e.key), ["gtin:222", "gtin:111"]);
    const repeated = s.entries[1];
    assert.equal(repeated.scanCount, 2);
    assert.equal(repeated.firstScannedAt, 1);
    assert.equal(repeated.lastScannedAt, 3);
    assert.equal(repeated.acted, "wishlisted");
    assert.equal(s.repeatKey, "gtin:111");
  });

  it("a later verdict of the same scan updates its entry (label photo after unknown barcode)", () => {
    let s = shelfReducer(EMPTY_SHELF, { type: "verdict", entry: entryFor({ kind: "not-found", gtin: "999" }) });
    s = shelfReducer(s, { type: "verdict", entry: entryFor({ kind: "add", candidate: candidate("notOwned") }, { captureId: "c1", now: 5 }) });
    assert.equal(s.entries.length, 1);
    assert.equal(s.entries[0].verdict, "new");
    assert.equal(s.entries[0].shadeId, "42");
    assert.equal(s.entries[0].key, "gtin:999");
    assert.equal(s.entries[0].scanCount, 1);
  });

  it("records actions and shows the new state", () => {
    let s = add(EMPTY_SHELF, "111", 1);
    assert.deepEqual(shelfQuickActions(s.entries[0]), ["add", "wishlist"]);
    s = shelfReducer(s, { type: "acted", key: "gtin:111", acted: "added", quantity: 1 });
    assert.equal(shelfStatus(s.entries[0]), "owned");
    assert.equal(s.entries[0].verdict, "new");
    assert.deepEqual(shelfQuickActions(s.entries[0]), ["bought_another"]);
    s = shelfReducer(s, { type: "acted", key: "gtin:111", acted: undefined });
    assert.equal(s.entries[0].acted, undefined);
    assert.equal(shelfReducer(s, { type: "acted", key: "gtin:nope", acted: "added" }), s);
  });

  it("caps the shelf, hydrates and clears", () => {
    let s = EMPTY_SHELF;
    for (let i = 0; i < SHELF_MAX_ENTRIES + 5; i += 1) {
      s = add(s, String(i), i);
      s = shelfReducer(s, { type: "scan_ended" });
    }
    assert.equal(s.entries.length, SHELF_MAX_ENTRIES);
    assert.equal(s.entries[0].gtin, String(SHELF_MAX_ENTRIES + 4));
    const hydrated = shelfReducer(EMPTY_SHELF, { type: "hydrated", entries: s.entries });
    assert.equal(hydrated.currentKey, null);
    assert.equal(hydrated.entries.length, SHELF_MAX_ENTRIES);
    assert.equal(shelfReducer(s, { type: "cleared" }), EMPTY_SHELF);
  });
});

describe("shelfCounts / quick actions", () => {
  it("counts by scanned verdict", () => {
    assert.deepEqual(
      shelfCounts([{ verdict: "owned" }, { verdict: "wishlist" }, { verdict: "new" }, { verdict: "near_dupe" }, { verdict: "not_found" }]),
      { total: 5, owned: 1, wishlist: 1, new: 2, notFound: 1 },
    );
  });

  it("offers actions by status", () => {
    assert.deepEqual(shelfQuickActions({ verdict: "wishlist", shadeId: "1" }), ["add"]);
    assert.deepEqual(shelfQuickActions({ verdict: "owned", shadeId: "1" }), ["bought_another"]);
    assert.deepEqual(shelfQuickActions({ verdict: "new" }), []);
    assert.deepEqual(shelfQuickActions({ verdict: "new", shadeId: "1", acted: "wishlisted" }), ["add"]);
  });
});

describe("persistence", () => {
  it("round-trips and drops malformed entries and non-hex colors", () => {
    const good = entryFor({ kind: "owned", candidate: candidate("owned"), quantity: 2 });
    const parsed = parseShelfEntries([good, { key: "x" }, null, { ...good, key: "gtin:2", hex: "data:image/png;base64,AAA" }, "junk"]);
    assert.equal(parsed.length, 2);
    assert.deepEqual(parsed[0], good);
    assert.equal(parsed[1].hex, undefined);
    assert.deepEqual(parseShelfEntries("nope"), []);
  });

  it("stores only known fields", () => {
    const stored = shelfToStored([{ ...entryFor({ kind: "not-found", gtin: "1" }), dataUrl: "data:...", imageUrl: "https://x/v3" } as ShelfEntry]);
    assert.deepEqual(Object.keys(stored[0]).sort(), ["firstScannedAt", "gtin", "key", "lastScannedAt", "scanCount", "verdict"]);
  });
});

describe("formatShelfAge", () => {
  it("formats", () => {
    assert.equal(formatShelfAge(0, 10_000), "just now");
    assert.equal(formatShelfAge(0, 120_000), "2 min ago");
    assert.equal(formatShelfAge(0, 3_600_000 * 2), "2 h ago");
  });
});
