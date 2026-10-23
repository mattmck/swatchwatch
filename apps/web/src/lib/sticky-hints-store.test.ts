import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_STICKY_HINTS, stickyHintsStorageKey, type StickyHints } from "swatchwatch-shared";
import { clearStickyHints, readStickyHints, writeStickyHints } from "./sticky-hints-store";

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
  return {
    get length() {
      return data.size;
    },
    key: (index: number) => [...data.keys()][index] ?? null,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
    clear: () => data.clear(),
  };
}

const throwing = new Proxy({} as Storage, {
  get() {
    throw new Error("blocked");
  },
});

const hints: StickyHints = {
  brand: "loud",
  brandCanonical: "Loud Lacquer",
  brandId: "9",
  finish: "creme",
  collection: "Summer",
};

describe("sticky hints store", () => {
  it("round-trips per user", () => {
    const storage = memoryStorage();
    writeStickyHints(storage, "1", hints);
    assert.deepEqual(readStickyHints(storage, "1"), hints);
    assert.deepEqual(readStickyHints(storage, "2"), EMPTY_STICKY_HINTS);
  });

  it("removes the key when hints are empty, but keeps finish/collection-only hints", () => {
    const storage = memoryStorage();
    writeStickyHints(storage, "1", hints);
    writeStickyHints(storage, "1", EMPTY_STICKY_HINTS);
    assert.equal(storage.getItem(stickyHintsStorageKey("1")), null);

    writeStickyHints(storage, "1", { ...EMPTY_STICKY_HINTS, finish: "creme" });
    assert.equal(readStickyHints(storage, "1").finish, "creme");
  });

  it("clears every user's hints and nothing else", () => {
    const storage = memoryStorage({ unrelated: "x", "swatchwatch.rapid-add.shelf:1": "[]" });
    writeStickyHints(storage, "1", hints);
    writeStickyHints(storage, "2", hints);
    writeStickyHints(storage, null, hints);
    clearStickyHints(storage);
    assert.equal(storage.length, 2);
    assert.equal(storage.getItem("unrelated"), "x");
    assert.equal(storage.getItem("swatchwatch.rapid-add.shelf:1"), "[]");
  });

  it("never throws on missing or blocked storage", () => {
    assert.deepEqual(readStickyHints(null, "1"), EMPTY_STICKY_HINTS);
    assert.deepEqual(readStickyHints(throwing, "1"), EMPTY_STICKY_HINTS);
    assert.doesNotThrow(() => writeStickyHints(null, "1", hints));
    assert.doesNotThrow(() => writeStickyHints(throwing, "1", hints));
    assert.doesNotThrow(() => clearStickyHints(null));
    assert.doesNotThrow(() => clearStickyHints(throwing));
  });
});
