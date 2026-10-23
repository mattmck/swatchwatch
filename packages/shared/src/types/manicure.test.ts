import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildWearHistory, wearHistoryTitle, type Manicure, type ManicurePolish } from "./manicure";

function polish(shadeId: string, position: number, role: ManicurePolish["role"] = "color"): ManicurePolish {
  return { shadeId, inventoryItemId: null, role, position, brand: "B", name: `N${shadeId}` };
}
function mani(id: string, wornOn: string, polishes: ManicurePolish[], photoUrl: string | null = null): Manicure {
  return { id, wornOn, notes: null, photoImageId: null, photoUrl, polishes, createdAt: "", updatedAt: "" };
}

describe("buildWearHistory", () => {
  const rows = [
    mani("1", "2026-10-01", [polish("7", 0)]),
    mani("3", "2026-10-05", [polish("8", 0, "base"), polish("7", 1, "accent")], "v3.x"),
    mani("2", "2026-10-05", [polish("7", 0)]),
  ];

  it("sorts newest first, ties by id desc", () => {
    assert.deepEqual(buildWearHistory(rows, 7).map((e) => e.manicureId), ["3", "2", "1"]);
  });
  it("reports the role of the shade and the others", () => {
    const [first] = buildWearHistory(rows, "7");
    assert.equal(first.role, "accent");
    assert.deepEqual(first.others.map((p) => p.shadeId), ["8"]);
    assert.equal(first.photoUrl, "v3.x");
  });
  it("limits and handles empty input", () => {
    assert.equal(buildWearHistory(rows, 7, 2).length, 2);
    assert.deepEqual(buildWearHistory([], 7), []);
  });
});

describe("wearHistoryTitle", () => {
  it("pluralizes", () => {
    assert.equal(wearHistoryTitle(0), "Not worn yet");
    assert.equal(wearHistoryTitle(1), "Worn 1 time");
    assert.equal(wearHistoryTitle(4), "Worn 4 times");
  });
});
