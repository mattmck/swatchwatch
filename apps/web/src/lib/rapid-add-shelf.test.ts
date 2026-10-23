import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PolishDupeHint } from "swatchwatch-shared";
import {
  clearAllShelves,
  EMPTY_SHELF,
  formatShelfAge,
  parseShelfEntries,
  readShelf,
  serializeShelfEntries,
  SHELF_MAX_ENTRIES,
  shelfActionEvent,
  shelfCounts,
  shelfDupeFromHint,
  shelfEntryFromVerdict,
  shelfNeedsDupeCheck,
  shelfQuickActions,
  shelfReducer,
  shelfStatus,
  shelfStorageKey,
  writeShelf,
  type ShelfEntry,
  type ShelfState,
} from "./rapid-add-shelf";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get length() {
      return data.size;
    },
    key: (i: number) => Array.from(data.keys())[i] ?? null,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}

function entry(overrides: Partial<ShelfEntry> = {}): ShelfEntry {
  return {
    key: "gtin:012345678905",
    captureId: "c1",
    gtin: "012345678905",
    verdict: "new",
    shadeId: "42",
    display: "OPI — Big Apple Red",
    firstScannedAt: 1000,
    lastScannedAt: 1000,
    scanCount: 1,
    ...overrides,
  };
}

describe("shelfEntryFromVerdict", () => {
  const ctx = { captureId: "c1", now: 5000 };

  it("maps a checked barcode match by relationship", () => {
    const owned = shelfEntryFromVerdict(
      { kind: "checked", relationship: "owned", display: "A", gtin: "111", shadeId: "1", quantity: 2, hex: "#FF0000" },
      ctx,
    );
    assert.equal(owned?.key, "gtin:111");
    assert.equal(owned?.verdict, "owned");
    assert.equal(owned?.quantity, 2);
    assert.equal(owned?.hex, "#FF0000");
    assert.equal(owned?.acted, undefined);

    const wish = shelfEntryFromVerdict({ kind: "checked", relationship: "wishlisted", display: "A", gtin: "111" }, ctx);
    assert.equal(wish?.verdict, "wishlist");

    const fresh = shelfEntryFromVerdict(
      { kind: "checked", relationship: "notOwned", display: "A", gtin: "111", wishlistedNow: true },
      ctx,
    );
    assert.equal(fresh?.verdict, "new");
    assert.equal(fresh?.acted, "wishlisted");
  });

  it("maps an unknown barcode to not found", () => {
    const e = shelfEntryFromVerdict({ kind: "unknown_barcode", gtin: "999", format: "ean_13" }, ctx);
    assert.deepEqual(
      { key: e?.key, verdict: e?.verdict, format: e?.format },
      { key: "gtin:999", verdict: "not_found", format: "ean_13" },
    );
  });

  it("keys finalize verdicts by capture and marks them acted", () => {
    const owned = shelfEntryFromVerdict(
      { kind: "owned", display: "A", inventoryItemId: "9", shadeId: "1", previousQuantity: 1, quantity: 2 },
      ctx,
    );
    assert.equal(owned?.key, "capture:c1");
    assert.equal(owned?.acted, "bought_another");
    assert.equal(owned?.quantity, 2);

    const restored = shelfEntryFromVerdict(
      { kind: "owned", display: "A", inventoryItemId: "9", previousQuantity: 1, quantity: 2 },
      { ...ctx, quantityRestored: true },
    );
    assert.equal(restored?.acted, undefined);
    assert.equal(restored?.quantity, 1);

    const added = shelfEntryFromVerdict({ kind: "added", display: "A", priorOwnership: "none" }, ctx);
    assert.equal(added?.verdict, "new");
    assert.equal(added?.acted, "added");
  });

  it("keeps the evidence of a not-found label scan and needs a key", () => {
    const e = shelfEntryFromVerdict({ kind: "add", evidence: { brand: "OPI", shadeName: "Red" } }, ctx);
    assert.equal(e?.verdict, "not_found");
    assert.equal(e?.brand, "OPI");
    assert.equal(shelfEntryFromVerdict({ kind: "add", evidence: {} }, { now: 1, captureId: null }), null);
  });
});

describe("shelfReducer", () => {
  it("appends newest first and caps the list", () => {
    let state: ShelfState = EMPTY_SHELF;
    state = shelfReducer(state, { type: "scanned", entry: entry({ key: "a" }) });
    state = shelfReducer(state, { type: "scanned", entry: entry({ key: "b" }) });
    assert.deepEqual(
      state.entries.map((e) => e.key),
      ["b", "a"],
    );
    for (let i = 0; i < SHELF_MAX_ENTRIES + 5; i += 1) {
      state = shelfReducer(state, { type: "scanned", entry: entry({ key: `k${i}` }) });
    }
    assert.equal(state.entries.length, SHELF_MAX_ENTRIES);
  });

  it("flags a repeat scan in place instead of appending", () => {
    let state = shelfReducer(EMPTY_SHELF, { type: "scanned", entry: entry({ key: "a", acted: "wishlisted" }) });
    state = shelfReducer(state, { type: "scanned", entry: entry({ key: "b" }) });
    state = shelfReducer(state, {
      type: "scanned",
      entry: entry({ key: "a", firstScannedAt: 9000, lastScannedAt: 9000 }),
    });
    assert.equal(state.entries.length, 2);
    assert.equal(state.repeatKey, "a");
    const a = state.entries.find((e) => e.key === "a")!;
    assert.equal(a.scanCount, 2);
    assert.equal(a.firstScannedAt, 1000);
    assert.equal(a.lastScannedAt, 9000);
    assert.equal(a.acted, "wishlisted", "an earlier action is kept");
    assert.deepEqual(
      state.entries.map((e) => e.key),
      ["b", "a"],
      "position is kept",
    );
    state = shelfReducer(state, { type: "scanned", entry: entry({ key: "c" }) });
    assert.equal(state.repeatKey, null);
  });

  it("updates the scan's entry from a later verdict of the same session", () => {
    const start = shelfReducer(EMPTY_SHELF, { type: "scanned", entry: entry({ verdict: "wishlist" }) });
    const after = shelfReducer(start, {
      type: "verdict_updated",
      key: "gtin:012345678905",
      entry: entry({ key: "capture:c1", verdict: "new", acted: "added", quantity: 1 }),
    });
    assert.equal(after.entries[0].verdict, "wishlist", "the chip keeps the scanned state");
    assert.equal(after.entries[0].acted, "added");
    assert.equal(shelfStatus(after.entries[0]), "owned");

    const unknown = shelfReducer(EMPTY_SHELF, {
      type: "scanned",
      entry: entry({ verdict: "not_found", shadeId: undefined, display: undefined }),
    });
    const learned = shelfReducer(unknown, {
      type: "verdict_updated",
      key: "gtin:012345678905",
      entry: entry({ key: "capture:c1", verdict: "new", acted: "added", display: "Found" }),
    });
    assert.equal(learned.entries[0].verdict, "new", "a label photo can find a not-found bottle");
    assert.equal(learned.entries[0].display, "Found");

    const undone = shelfReducer(
      shelfReducer(EMPTY_SHELF, { type: "scanned", entry: entry({ verdict: "owned", acted: "bought_another" }) }),
      { type: "verdict_updated", key: "gtin:012345678905", entry: entry({ verdict: "owned", quantity: 1 }), clearActed: true },
    );
    assert.equal(undone.entries[0].acted, undefined);
  });

  it("records actions and dupes", () => {
    let state = shelfReducer(EMPTY_SHELF, { type: "scanned", entry: entry() });
    state = shelfReducer(state, { type: "dupe_resolved", key: "gtin:012345678905", dupe: { grade: "medium", name: "X Y" } });
    assert.equal(state.entries[0].verdict, "near_dupe");
    state = shelfReducer(state, { type: "acted", key: "gtin:012345678905", acted: "added", quantity: 1 });
    assert.equal(state.entries[0].acted, "added");
    assert.equal(state.entries[0].quantity, 1);
    assert.equal(shelfReducer(state, { type: "acted", key: "missing", acted: "added" }), state);
    assert.deepEqual(shelfReducer(state, { type: "cleared" }), EMPTY_SHELF);
  });
});

describe("shelf views", () => {
  it("counts by the scanned verdict", () => {
    const counts = shelfCounts([
      { verdict: "owned" },
      { verdict: "wishlist" },
      { verdict: "new" },
      { verdict: "near_dupe" },
      { verdict: "not_found" },
      { verdict: "not_found" },
    ]);
    assert.deepEqual(counts, { total: 6, owned: 1, wishlist: 1, new: 2, nearDupe: 1, notFound: 2 });
  });

  it("offers the quick actions for the entry's current state", () => {
    assert.deepEqual(shelfQuickActions(entry()), ["add", "wishlist"]);
    assert.deepEqual(shelfQuickActions(entry({ verdict: "near_dupe" })), ["add", "wishlist"]);
    assert.deepEqual(shelfQuickActions(entry({ acted: "wishlisted" })), ["add"]);
    assert.deepEqual(shelfQuickActions(entry({ verdict: "wishlist" })), ["add"]);
    assert.deepEqual(shelfQuickActions(entry({ acted: "added" })), ["bought_another"]);
    assert.deepEqual(shelfQuickActions(entry({ verdict: "owned" })), ["bought_another"]);
    assert.deepEqual(shelfQuickActions(entry({ verdict: "not_found" })), ["manual"]);
    assert.deepEqual(shelfQuickActions(entry({ shadeId: undefined })), ["add"], "SKU without a shade: finalize");
    assert.deepEqual(shelfQuickActions(entry({ shadeId: undefined, captureId: null })), []);
  });

  it("asks for dupes only for unowned catalog shades", () => {
    assert.equal(shelfNeedsDupeCheck(entry()), true);
    assert.equal(shelfNeedsDupeCheck(entry({ verdict: "wishlist" })), false);
    assert.equal(shelfNeedsDupeCheck(entry({ shadeId: undefined })), false);
    assert.equal(shelfNeedsDupeCheck(entry({ acted: "added" })), false);
  });

  it("reads the best dupe from a hint", () => {
    const hint = {
      shadeId: "42",
      best: { shadeId: "7", brand: "Zoya", name: "Sooki", grade: "high" },
      dupeCount: 1,
      highCount: 1,
    } as unknown as PolishDupeHint;
    assert.deepEqual(shelfDupeFromHint(hint), { grade: "high", name: "Zoya Sooki" });
    assert.equal(shelfDupeFromHint({ ...hint, best: null }), null);
    assert.equal(shelfDupeFromHint(undefined), null);
  });

  it("formats ages", () => {
    assert.equal(formatShelfAge(0, 10_000), "just now");
    assert.equal(formatShelfAge(0, 120_000), "2 min ago");
    assert.equal(formatShelfAge(0, 2 * 3_600_000), "2 h ago");
    assert.equal(formatShelfAge(10_000, 0), "just now");
  });

  it("builds the telemetry event", () => {
    assert.deepEqual(shelfActionEvent("add", 3, "new"), {
      name: "rapid_add.shelf_action",
      properties: { action: "add", shelfSize: 3, verdict: "new" },
    });
    assert.deepEqual(shelfActionEvent("clear", 0).properties, { action: "clear", shelfSize: 0 });
  });
});

describe("shelf storage", () => {
  it("keys per user", () => {
    assert.equal(shelfStorageKey("12"), "swatchwatch.rapid-add.shelf:12");
    assert.equal(shelfStorageKey(null), "swatchwatch.rapid-add.shelf");
  });

  it("round-trips entries and drops anything else", () => {
    const stored = serializeShelfEntries([
      { ...entry({ hex: "#AABBCC", dupe: { grade: "medium", name: "X" } }), dataUrl: "data:image/png;base64,AAAA" } as ShelfEntry,
    ]);
    assert.ok(!stored.includes("data:image"), "image data is never stored");
    const [back] = parseShelfEntries(stored);
    assert.equal(back.hex, "#AABBCC");
    assert.deepEqual(back.dupe, { grade: "medium", name: "X" });
    assert.equal(back.display, "OPI — Big Apple Red");
  });

  it("rejects corrupt storage and malformed entries", () => {
    assert.deepEqual(parseShelfEntries("not json"), []);
    assert.deepEqual(parseShelfEntries("{}"), []);
    assert.deepEqual(parseShelfEntries(JSON.stringify([{ key: "a", verdict: "bogus" }, null])), []);
    assert.deepEqual(parseShelfEntries(null), []);
    const [noHex] = parseShelfEntries(JSON.stringify([{ ...entry(), hex: "data:image/png;base64,AA" }]));
    assert.equal(noHex.hex, undefined);
  });

  it("writes, removes when empty, and clears every user's shelf", () => {
    const storage = memoryStorage({ other: "keep" });
    const key = shelfStorageKey("1");
    writeShelf(storage, key, [entry()]);
    assert.equal(readShelf(storage, key).length, 1);
    writeShelf(storage, shelfStorageKey("2"), [entry()]);
    writeShelf(storage, shelfStorageKey(null), [entry()]);
    writeShelf(storage, key, []);
    assert.equal(storage.getItem(key), null);
    clearAllShelves(storage);
    assert.deepEqual(Array.from(storage.data.keys()), ["other"]);
  });

  it("survives storage that throws", () => {
    const broken = {
      length: 1,
      key: () => {
        throw new Error("blocked");
      },
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    assert.deepEqual(readShelf(broken, "k"), []);
    assert.doesNotThrow(() => writeShelf(broken, "k", [entry()]));
    assert.doesNotThrow(() => clearAllShelves(broken));
    assert.deepEqual(readShelf(null, "k"), []);
  });
});
