import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decideName, GENERIC_LABEL_NAMES, matchName, NAME_MATCH_RULES, rankNames, type MatchListEntry } from "./name-match";

const list = (...names: string[]): MatchListEntry[] => names.map((name, i) => ({ shadeId: i + 1, name }));

describe("rankNames", () => {
  it("returns one row per distinct normalised name, best first", () => {
    const ranked = rankNames(["Latte", "Matcha Latte"], list("Latte", "Matcha Latte", "LATTE!", "Cherry"));
    assert.deepEqual(ranked.map((r) => r.name), ["Latte", "Matcha Latte", "Cherry"]);
    assert.equal(ranked[0].similarity, 1);
    assert.equal(ranked[1].similarity, 1);
  });
  it("counts non-code aliases as names of the same shade and ignores vendor codes", () => {
    const entries: MatchListEntry[] = [{ shadeId: 7, name: "Plain", aliases: ["Retailer Listing Title", "NLF008", "plain"] }];
    const ranked = rankNames(["Retailer Listing Title", "NLF008"], entries);
    assert.deepEqual(ranked.map((r) => [r.shadeId, r.name]), [[7, "Retailer Listing Title"], [7, "Plain"]]);
    assert.equal(ranked[0].similarity, 1);
  });
});

describe("matchName", () => {
  it("matches a pun on its own spelling, not a corrected one", () => {
    const entries = list("Don't Be Koi", "Don't Be Coy", "Fin-tastic");
    assert.equal(matchName(["DON'T BE KOI"], entries)?.shadeId, 1);
    assert.equal(matchName(["Dont be coy"], entries)?.shadeId, 2);
  });
  it("Latte matches Latte although Matcha Latte is in the list", () => {
    assert.equal(matchName(["Latte"], list("Latte", "Matcha Latte"))?.shadeId, 1);
  });
  it("an exact name beats the lead rule when a near name is close behind", () => {
    const entries = list("Berry", "Berrys");
    const decision = matchName(["Berry"], entries);
    assert.equal(decision?.shadeId, 1);
    assert.equal(decision?.rule, "exact");
    assert.equal(matchName(["Berry"], entries, { exactBeatsLead: false }), null);
  });
  it("needs the lead over the runner-up when the name is not exact", () => {
    const entries = list("Berry Blast", "Berry Bliss");
    assert.equal(matchName(["Berry Blas"], entries), null);
  });
  it("never matches a generic label name from the text", () => {
    assert.ok(GENERIC_LABEL_NAMES.has("nailpolish"));
    const entries = list("Nail Polish", "Cherry Bomb");
    assert.equal(matchName(["NAIL POLISH"], entries), null);
    assert.equal(rankNames(["NAIL POLISH"], entries).some((r) => r.normalizedName === "nailpolish"), false);
  });
  it("skips names below minChars and honours a higher minChars", () => {
    assert.equal(matchName(["Ox"], list("Ox", "Zebra")), null);
    assert.equal(matchName(["Ice"], list("Ice", "Zebra"))?.shadeId, 1);
    assert.equal(matchName(["Ice"], list("Ice", "Zebra"), { minChars: 5 }), null);
  });
  it("exposes the measured rule numbers", () => {
    assert.deepEqual({ ...NAME_MATCH_RULES }, { minSimilarity: 0.8, minLead: 0.25, exactSimilarity: 0.999, minChars: 3 });
  });
});

describe("decideName", () => {
  it("is null for an empty ranking and reports the lead", () => {
    assert.equal(decideName([]), null);
    const d = decideName([
      { shadeId: 1, name: "A", normalizedName: "a", similarity: 0.9 },
      { shadeId: 2, name: "B", normalizedName: "b", similarity: 0.5 },
    ]);
    assert.equal(d?.rule, "lead");
    assert.ok(Math.abs((d?.lead ?? 0) - 0.4) < 1e-9);
  });
  it("does not treat a shade's own alias as the runner-up", () => {
    const d = decideName([
      { shadeId: 1, name: "Foo", normalizedName: "foo", similarity: 0.9 },
      { shadeId: 1, name: "Foo Listing", normalizedName: "foolisting", similarity: 0.85 },
      { shadeId: 2, name: "Bar", normalizedName: "bar", similarity: 0.3 },
    ]);
    assert.equal(d?.shadeId, 1);
  });
});
