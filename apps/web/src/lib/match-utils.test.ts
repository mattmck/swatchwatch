import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PolishMatch } from "swatchwatch-shared";
import {
  countMatchesByColor,
  filterMatchesByColor,
  formatFraction,
  matchPercent,
} from "../app/(app)/polishes/match/match-utils";

function match(id: string, matchedColor: string, distance = 0.01): PolishMatch {
  return {
    polish: {
      id,
      shadeId: id,
      userId: "1",
      brand: "Brand",
      name: `Shade ${id}`,
      color: "",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    },
    matchedColor,
    distance,
    confidence: "high",
  };
}

describe("match-utils", () => {
  const matches = [match("1", "#D01020"), match("2", "#1030C0"), match("3", "#D01020")];

  it("filterMatchesByColor returns all when no color is selected", () => {
    assert.equal(filterMatchesByColor(matches, null).length, 3);
  });

  it("filterMatchesByColor filters case-insensitively by matched color", () => {
    assert.deepEqual(
      filterMatchesByColor(matches, "#d01020").map((m) => m.polish.id),
      ["1", "3"],
    );
  });

  it("countMatchesByColor tallies matches per extracted color", () => {
    const counts = countMatchesByColor(matches);
    assert.equal(counts.get("#D01020"), 2);
    assert.equal(counts.get("#1030C0"), 1);
  });

  it("matchPercent maps distance 0 → 100 and clamps at 0", () => {
    assert.equal(matchPercent(0), 100);
    assert.equal(matchPercent(0.05), 90);
    assert.equal(matchPercent(0.5), 0);
    assert.equal(matchPercent(2), 0);
  });

  it("formatFraction renders whole percents with a <1% floor", () => {
    assert.equal(formatFraction(0.456), "46%");
    assert.equal(formatFraction(0.004), "<1%");
  });
});
