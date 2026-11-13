import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { editSimilarity, levenshteinDistance, normalizeMatchText } from "./normalize";

describe("normalizeMatchText", () => {
  it("drops case, spaces, punctuation and apostrophes", () => {
    assert.equal(normalizeMatchText("Don’t Be Koi"), "dontbekoi");
    assert.equal(normalizeMatchText("Don't Be Koi"), "dontbekoi");
    assert.equal(normalizeMatchText("Suzi Takes A Sound Bath®"), "suzitakesasoundbath");
    assert.equal(normalizeMatchText("Glass Candy™ Top Coat"), "glasscandytopcoat");
    assert.equal(normalizeMatchText("Harry Potter℠ Lumos (TM)"), "harrypotterlumos");
  });
  it("maps superscript two, ampersand and strips accents", () => {
    assert.equal(normalizeMatchText("H²O"), "h2o");
    assert.equal(normalizeMatchText("Salt & Vinegar"), "saltandvinegar");
    assert.equal(normalizeMatchText("Côte"), "cote");
  });
  it("drops (R) (TM) (C) marks and handles empty input", () => {
    assert.equal(normalizeMatchText("Foo (R) Bar (c)"), "foobar");
    assert.equal(normalizeMatchText("  --  "), "");
    assert.equal(normalizeMatchText(""), "");
  });
});

describe("levenshteinDistance / editSimilarity", () => {
  it("handles empty, equal and shared affixes", () => {
    assert.equal(levenshteinDistance("", ""), 0);
    assert.equal(levenshteinDistance("", "abc"), 3);
    assert.equal(levenshteinDistance("abc", ""), 3);
    assert.equal(levenshteinDistance("same", "same"), 0);
    assert.equal(levenshteinDistance("kitten", "sitting"), 3);
    assert.equal(levenshteinDistance("flaw", "lawn"), 2);
    assert.equal(levenshteinDistance("prefixabcsuffix", "prefixxyzsuffix"), 3);
  });
  it("is symmetric", () => {
    assert.equal(levenshteinDistance("latte", "matchalatte"), levenshteinDistance("matchalatte", "latte"));
  });
  it("is 1 - distance / max length, 0 when either side is empty", () => {
    assert.equal(editSimilarity("abcd", "abcd"), 1);
    assert.equal(editSimilarity("abcd", "abce"), 0.75);
    assert.equal(editSimilarity("", "abc"), 0);
    assert.equal(editSimilarity("abc", ""), 0);
    assert.equal(editSimilarity("", ""), 0);
  });
});
