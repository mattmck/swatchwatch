import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { recommendLooks, DEFAULT_VIBE, type Polish } from "swatchwatch-shared";
import { addSavedLook, applySwaps, catalogGapQueries, maniEntriesFromLook, NO_SWAPS, shoppingItemPriceLine, withSwap, maniEntriesFromSavedLook, nextSeed, parseCachedSkinTone, toSavedLook, TOPPER_QUERY_KEY } from "./looks";

let id = 1;
function polish(hex: string, extra: Partial<Polish> = {}): Polish {
  const n = String(id++);
  return { id: n, shadeId: n, userId: "1", brand: "B", name: `S${n}`, status: "owned", vendorHex: hex, finishes: ["creme"], createdAt: "", updatedAt: "", ...extra } as Polish;
}

describe("catalogGapQueries", () => {
  it("asks the API for the catalog nearest the gaps, one query per family, plus toppers", () => {
    // An empty collection: every step is a template swatch to fill from the catalog.
    const { looks } = recommendLooks({ polishes: [], vibe: DEFAULT_VIBE, seed: 1 });
    const queries = catalogGapQueries(looks);
    assert.ok(queries.length > 0 && queries.length <= 7);
    for (const q of queries) {
      if (q.key === TOPPER_QUERY_KEY) assert.ok(q.filters.finishes?.includes("topper"));
      else {
        assert.equal(q.filters.families?.length, 1);
        assert.ok((q.filters.nearHex?.length ?? 0) > 0);
        assert.match(q.key, /^family:/);
      }
    }
    assert.equal(new Set(queries.map((q) => q.key)).size, queries.length);
  });

  it("needs nothing when every step is owned", () => {
    const owned = [polish("#D8BFAA"), polish("#A8846A"), polish("#F3E6E8", { finishes: ["sheer"] })];
    const { looks } = recommendLooks({ polishes: owned, vibe: { ...DEFAULT_VIBE, ownedOnly: true }, seed: 1 });
    assert.ok(looks.length > 0);
    assert.deepEqual(catalogGapQueries(looks), []);
  });
});

describe("saved looks", () => {
  const owned = [polish("#D8BFAA"), polish("#A8846A")];
  const { looks } = recommendLooks({ polishes: owned, vibe: { ...DEFAULT_VIBE, ownedOnly: true }, seed: 1 });
  const look = looks[0];

  it("snapshots a look with its key, vibe and shade ids", () => {
    const saved = toSavedLook(look, DEFAULT_VIBE, new Date("2026-10-23T00:00:00Z"));
    assert.equal(saved.templateId, look.templateId);
    assert.equal(saved.savedAt, "2026-10-23T00:00:00.000Z");
    assert.ok(saved.id.startsWith(`${look.templateId}:`));
    assert.deepEqual(saved.steps.map((s) => s.shadeId), look.steps.map((s) => s.polish?.id));
  });

  it("dedupes by key, newest first", () => {
    const a = toSavedLook(look, DEFAULT_VIBE, new Date(1));
    const b = { ...a, savedAt: new Date(2).toISOString() };
    assert.deepEqual(addSavedLook([a], b).map((l) => l.savedAt), [b.savedAt]);
  });

  it("builds mani entries from owned steps only, with 'color' for the base", () => {
    const entries = maniEntriesFromLook(look);
    assert.equal(entries[0].role, "color");
    assert.equal(entries.length, look.ownedSteps);
    const fromSaved = maniEntriesFromSavedLook(toSavedLook(look, DEFAULT_VIBE, new Date(1)));
    assert.deepEqual(fromSaved.map((e) => [e.shadeId, e.role]), entries.map((e) => [e.shadeId, e.role]));
  });
});

describe("nextSeed", () => {
  it("never repeats the current seed", () => {
    assert.notEqual(nextSeed(5, () => 4 / 1_000_000), 5);
    assert.ok(nextSeed(1) >= 1);
  });
});

describe("parseCachedSkinTone", () => {
  it("accepts a stored choice, fills a missing axis, and treats junk as none", () => {
    assert.deepEqual(parseCachedSkinTone({ undertone: "warm", depth: "tan" }), { undertone: "warm", depth: "tan" });
    assert.deepEqual(parseCachedSkinTone({ depth: "deep" }), { undertone: "neutral", depth: "deep" });
    assert.equal(parseCachedSkinTone(null), null);
    assert.equal(parseCachedSkinTone("warm"), null);
    assert.equal(parseCachedSkinTone({ undertone: "x", depth: "y" }), null);
  });
});

describe("swaps", () => {
  const owned = [polish("#D8BFAA"), polish("#D2B8A3"), polish("#A8846A"), polish("#F3E6E8", { finishes: ["sheer"] })];
  const { looks } = recommendLooks({ polishes: owned, vibe: { ...DEFAULT_VIBE, ownedOnly: true }, seed: 1 });
  const look = looks[0];
  const step = look.steps.find((s) => s.alternatives.length > 0);

  it("swaps an owned alternative in and keeps the old polish as an alternative", () => {
    assert.ok(step, "fixture has a step with alternatives");
    const alt = step.alternatives[0];
    const next = withSwap(NO_SWAPS, "k1", look, step.role, alt);
    const [swapped] = applySwaps([look], next, "k1");
    const after = swapped.steps.find((s) => s.role === step.role);
    assert.equal(after?.polish?.id, alt.id);
    assert.ok(after?.alternatives.some((a) => a.id === step.polish?.id));
  });

  it("drops swaps made for another recommendation (Shuffle, vibe change)", () => {
    assert.ok(step);
    const next = withSwap(NO_SWAPS, "k1", look, step.role, step.alternatives[0]);
    assert.equal(applySwaps([look], next, "k2")[0], look);
    // A swap under a new key starts from scratch instead of merging the stale ones.
    const other = looks[1];
    const again = withSwap(next, "k2", other, other.steps[0].role, other.steps[0].alternatives[0] ?? other.steps[0].polish!);
    assert.deepEqual(Object.keys(again.looks), [other.templateId]);
  });
});

describe("shoppingItemPriceLine", () => {
  it("formats the brand price with the as-of date, and is null without a price", () => {
    const line = shoppingItemPriceLine({ price: { amount: 14, currency: "USD" }, priceSeenAt: "2026-10-21T12:00:00.000Z" }, "en-US");
    assert.equal(line, "$14.00 · as of Oct 21, 2026");
    assert.equal(shoppingItemPriceLine({ price: null, priceSeenAt: null }), null);
  });
});

describe("catalogGapQueries includeOwned", () => {
  it("also queries the owned steps' colors for the substitutes sheets", () => {
    const owned = [polish("#D8BFAA"), polish("#A8846A"), polish("#F3E6E8", { finishes: ["sheer"] })];
    const { looks } = recommendLooks({ polishes: owned, vibe: { ...DEFAULT_VIBE, ownedOnly: true }, seed: 1 });
    assert.deepEqual(catalogGapQueries(looks), []);
    assert.ok(catalogGapQueries(looks, { includeOwned: true }).length > 0);
  });
});
