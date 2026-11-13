import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decideName, GENERIC_LABEL_NAMES, isBrandText, matchName, NAME_MATCH_RULES, rankNames, type MatchListEntry } from "./name-match";

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
      { shadeId: 1, shadeIds: [1], name: "A", normalizedName: "a", similarity: 0.9 },
      { shadeId: 2, shadeIds: [2], name: "B", normalizedName: "b", similarity: 0.5 },
    ]);
    assert.equal(d?.rule, "lead");
    assert.ok(Math.abs((d?.lead ?? 0) - 0.4) < 1e-9);
  });
  it("does not treat a shade's own alias as the runner-up", () => {
    const d = decideName([
      { shadeId: 1, shadeIds: [1], name: "Foo", normalizedName: "foo", similarity: 0.9 },
      { shadeId: 1, shadeIds: [1], name: "Foo Listing", normalizedName: "foolisting", similarity: 0.85 },
      { shadeId: 2, shadeIds: [2], name: "Bar", normalizedName: "bar", similarity: 0.3 },
    ]);
    assert.equal(d?.shadeId, 1);
  });
  it("never decides a name more than one shade carries", () => {
    const ranked = rankNames(["Snow Much Fun"], [
      { shadeId: 1, name: "Snow Much Fun" },
      { shadeId: 2, name: "Other" },
      { shadeId: 3, name: "Snow-Much Fun!" },
    ]);
    assert.deepEqual(ranked[0].shadeIds, [1, 3]);
    assert.equal(decideName(ranked), null);
  });
});

describe("rankNames — generic read phrases", () => {
  it("does not rank a phrase that is generic label text, unless asked to", () => {
    const list = [{ shadeId: 1, name: "Nail Police" }];
    assert.equal(rankNames(["NAIL POLISH"], list)[0].similarity, 0);
    assert.ok(rankNames(["NAIL POLISH"], list, { skipStopPhrases: false })[0].similarity >= 0.8);
  });
});

describe("isBrandText and the brandNames option", () => {
  const starrily = list("Stars", "Star Crossed", "Star Cluster", "Sparkler", "Serenity", "Orion's Belt", "Dark Music");
  it("is true for the brand, a misread of it and a truncated or split brand word", () => {
    for (const phrase of ["starrily", "starrly", "stary", "sarriy", "starr", "star", "tarrily"]) {
      assert.equal(isBrandText(phrase, "starrily"), true, phrase);
    }
  });
  it("is false for real shade names, even ones sharing a first letter or a short prefix", () => {
    // Longer than the brand, or too different from its same-length prefix.
    for (const phrase of ["starcrossed", "starcluster", "sparkler", "serenity", "orionsbelt", "darkmusic", "stella"]) {
      assert.equal(isBrandText(phrase, "starrily"), false, phrase);
    }
    assert.equal(isBrandText("", "starrily"), false);
    assert.equal(isBrandText("stars", ""), false);
  });
  it("Starrily misread as Stary no longer matches the shade Stars", () => {
    // Without the option the misread leads (0.8 vs Star Crossed under 0.5) and decides a wrong shade.
    assert.equal(matchName(["Stary"], starrily)?.shadeId, 1);
    assert.equal(matchName(["Stary"], starrily, { brandNames: ["Starrily"] }), null);
  });
  it("a phrase equal to the brand, or a prefix fragment of it, is not ranked", () => {
    const ranked = rankNames(["Starrily", "Star", "Starr"], starrily, { brandNames: ["Starrily"] });
    assert.ok(ranked.every((row) => row.similarity < 0.8));
    assert.equal(decideName(ranked), null);
  });
  it("Stars spelled exactly is a fragment of Starrily and is dropped: that shade cannot be identified by text", () => {
    assert.equal(isBrandText("stars", "starrily"), true);
    assert.equal(matchName(["Stars"], starrily)?.shadeId, 1);
    assert.equal(matchName(["Stars"], starrily, { brandNames: ["Starrily"] }), null);
  });
  it("real shade names still rank and match: Star Crossed, Star Cluster, Orion's Belt", () => {
    for (const [phrase, shadeId] of [["Star Crossed", 2], ["Star Cluster", 3], ["ORION'S BELT", 6]] as const) {
      assert.equal(matchName([phrase], starrily, { brandNames: ["Starrily"] })?.shadeId, shadeId, phrase);
    }
  });
  it("without brandNames nothing changes, and several or blank brand names are tolerated", () => {
    const before = rankNames(["Starrly", "Stars"], starrily);
    assert.deepEqual(rankNames(["Starrly", "Stars"], starrily, { brandNames: [] }), before);
    assert.deepEqual(rankNames(["Starrly", "Stars"], starrily, { brandNames: [""] }), before);
    assert.equal(matchName(["Stars"], starrily, { brandNames: ["Other Brand", "Starrily"] }), null);
  });
});
