import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTextPhrases, DEFAULT_TEXT_REGION, type RecognizedTextLine } from "./text-lines";

const line = (text: string, x = 0.5, y = 0.5, confidence = 1): RecognizedTextLine => ({ text, confidence, x, y });

describe("buildTextPhrases", () => {
  it("builds singles, pairs in both orders and triples forward and reversed", () => {
    const { phrases } = buildTextPhrases([[line("A"), line("B"), line("C")]]);
    assert.deepEqual(new Set(phrases), new Set(["A", "B", "C", "A B", "B A", "B C", "C B", "A B C", "C B A"]));
  });
  it("maxJoin limits the joins", () => {
    const lines = [[line("A"), line("B"), line("C")]];
    assert.deepEqual(new Set(buildTextPhrases(lines, { maxJoin: 1 }).phrases), new Set(["A", "B", "C"]));
    assert.equal(buildTextPhrases(lines, { maxJoin: 2 }).phrases.includes("A B C"), false);
  });
  it("ignores background text outside the centre region and low confidence lines", () => {
    assert.deepEqual(DEFAULT_TEXT_REGION, { min: 0.18, max: 0.82 });
    const { phrases } = buildTextPhrases([[line("SHELF", 0.05, 0.5), line("TOP", 0.5, 0.95), line("Name", 0.5, 0.5), line("blur", 0.5, 0.5, 0.1)]]);
    assert.deepEqual(phrases, ["Name"]);
    assert.deepEqual(buildTextPhrases([[line("EDGE", 0.05, 0.5)]], { region: null }).phrases, ["EDGE"]);
  });
  it("joins lines only within one recognition", () => {
    const { phrases } = buildTextPhrases([[line("A")], [line("B")]]);
    assert.deepEqual(new Set(phrases), new Set(["A", "B"]));
  });
  it("joins the filtered lines, so a dropped line does not break a name", () => {
    const { phrases } = buildTextPhrases([[line("Matcha"), line("noise", 0.01, 0.5), line("Latte")]]);
    assert.ok(phrases.includes("Matcha Latte"));
  });
  it("collects words and space-free lines as tokens", () => {
    const { tokens } = buildTextPhrases([[line("NLF 008 x")]]);
    assert.deepEqual(new Set(tokens), new Set(["NLF", "008", "x", "NLF008x"]));
  });
});
