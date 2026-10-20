import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DUPE_LIMITS, type PolishDupe, type PolishDupeHint, type PolishDupesBatchResponse } from "swatchwatch-shared";
import {
  chunkShadeIds,
  dupeCalloutText,
  dupeHintLabel,
  dupeHintShadeIds,
  dupeHintTitle,
  dupeHref,
  dupeVerdict,
  fetchDupeHints,
  keepDupeHints,
} from "./dupes";

function dupe(overrides: Partial<PolishDupe> = {}): PolishDupe {
  return {
    shadeId: "7",
    brand: "Holo Taco",
    name: "Red Velvet",
    finishes: ["creme"],
    displayHex: "#B0303A",
    displayHexSource: "vendor",
    distance: 0.012,
    colorGrade: "high",
    grade: "high",
    finishCompatibility: "same",
    ...overrides,
  };
}

function hint(best: PolishDupe | null, dupeCount = best ? 1 : 0, highCount = best?.grade === "high" ? 1 : 0): PolishDupeHint {
  return { shadeId: "1", best, dupeCount, highCount };
}

describe("dupeHintShadeIds", () => {
  it("skips coats, treatments and accessories, which never have dupes (#349)", () => {
    assert.deepEqual(
      dupeHintShadeIds([
        { id: "1", status: null, productCategory: "color" },
        { id: "2", status: null, productCategory: "topper" },
        { id: "3", status: null, productCategory: "top_coat" },
        { id: "4", status: "wishlist", productCategory: "accessory" },
        { id: "5", status: null },
      ]),
      ["1", "2", "5"]
    );
  });

  it("selects catalog and wishlist rows, never owned rows", () => {
    const ids = dupeHintShadeIds([
      { id: "1", status: "owned" },
      { id: "2", status: "wishlist" },
      { id: "3" },
      { id: "4", status: null },
      { id: "5", status: "destash" },
      { id: "2", status: "wishlist" },
    ]);
    assert.deepEqual(ids, ["2", "3", "4", "5"]);
  });
});

describe("keepDupeHints (#330)", () => {
  const previous = { "2": hint(dupe()), "3": hint(null), "4": hint(dupe({ shadeId: "8" })) };

  it("keeps hints for rows that are still listed while a refetch is in flight", () => {
    // Row 3 was just added (now owned) and left the hint list; rows 2 and 4 keep their badges.
    assert.deepEqual(keepDupeHints(previous, ["2", "4"]), { "2": previous["2"], "4": previous["4"] });
  });

  it("drops hints for ids that left the list (e.g. the previous page)", () => {
    assert.deepEqual(keepDupeHints(previous, ["9"]), {});
    assert.deepEqual(keepDupeHints(previous, []), {});
  });

  it("returns the same object when nothing needs dropping", () => {
    assert.equal(keepDupeHints(previous, ["2", "3", "4", "5"]), previous);
  });
});

describe("chunkShadeIds / fetchDupeHints", () => {
  it("chunks to the batch cap", () => {
    const ids = Array.from({ length: DUPE_LIMITS.batchMaxShadeIds * 2 + 1 }, (_, i) => String(i + 1));
    const chunks = chunkShadeIds(ids);
    assert.deepEqual(chunks.map((c) => c.length), [DUPE_LIMITS.batchMaxShadeIds, DUPE_LIMITS.batchMaxShadeIds, 1]);
    assert.deepEqual(chunkShadeIds([], 10), []);
  });

  it("merges chunked responses and skips the network for an empty list", async () => {
    const calls: string[][] = [];
    const fetchBatch = async (ids: string[]): Promise<PolishDupesBatchResponse> => {
      calls.push(ids);
      return {
        candidateCount: 3,
        results: Object.fromEntries(ids.map((id) => [id, { shadeId: id, best: null, dupeCount: 0, highCount: 0 }])),
      };
    };
    const ids = Array.from({ length: DUPE_LIMITS.batchMaxShadeIds + 5 }, (_, i) => String(i + 1));
    const merged = await fetchDupeHints([...ids, "1"], fetchBatch);
    assert.equal(calls.length, 2, "one request per chunk, not per row");
    assert.equal(Object.keys(merged).length, ids.length);
    assert.deepEqual(await fetchDupeHints([], fetchBatch), {});
    assert.equal(calls.length, 2);
  });
});

describe("labels", () => {
  it("dupeHintLabel distinguishes close and near dupes", () => {
    assert.equal(dupeHintLabel(hint(dupe())), "Dupe owned");
    assert.equal(dupeHintLabel(hint(dupe({ grade: "medium" }))), "Near dupe owned");
    assert.equal(dupeHintLabel(hint(null)), null);
    assert.equal(dupeHintLabel(undefined), null);
  });

  it("dupeHintTitle names the best dupe and the remainder", () => {
    assert.equal(
      dupeHintTitle(hint(dupe(), 3, 2)),
      "You own Holo Taco Red Velvet — close dupe, same finish (+2 more)"
    );
    assert.equal(
      dupeHintTitle(hint(dupe({ grade: "medium", finishCompatibility: "different" }))),
      "You own Holo Taco Red Velvet — near dupe, different finish"
    );
  });

  it("dupeCalloutText pluralizes and splits close/near", () => {
    assert.equal(dupeCalloutText({ dupeCount: 2, highCount: 2 }), "You own 2 close dupes");
    assert.equal(dupeCalloutText({ dupeCount: 1, highCount: 1 }), "You own 1 close dupe");
    assert.equal(dupeCalloutText({ dupeCount: 1, highCount: 0 }), "You own 1 near dupe");
    assert.equal(dupeCalloutText({ dupeCount: 3, highCount: 1 }), "You own 3 possible dupes (1 close)");
    assert.equal(dupeCalloutText({ dupeCount: 0, highCount: 0 }), null);
    assert.equal(dupeCalloutText(null), null);
  });
});

describe("dupeVerdict", () => {
  it("works from a batch hint or a full response", () => {
    assert.equal(dupeVerdict(hint(dupe())).kind, "dupe-owned");
    assert.equal(dupeVerdict(hint(dupe({ grade: "medium" }))).kind, "near-dupe-owned");
    assert.equal(dupeVerdict({ dupes: [dupe({ shadeId: "9" })] }).best?.shadeId, "9");
    assert.deepEqual(dupeVerdict({ dupes: [] }), { kind: "none", best: null });
    assert.deepEqual(dupeVerdict(null), { kind: "none", best: null });
  });
});

describe("dupeHref", () => {
  it("links to the detail page with a returnTo (#348)", () => {
    // No window (prerender) and no returnTo: plain link.
    assert.equal(dupeHref({ shadeId: "7" }), "/polishes/detail?id=7");
    assert.equal(dupeHref({ shadeId: "7" }, null), "/polishes/detail?id=7");
    assert.equal(dupeHref({ shadeId: "7" }, "/polishes?scope=all"), "/polishes/detail?id=7&returnTo=%2Fpolishes%3Fscope%3Dall");
  });
});
