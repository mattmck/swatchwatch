import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatFraction, matchPercent } from "../app/(app)/polishes/match/match-utils";

describe("match-utils", () => {
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
