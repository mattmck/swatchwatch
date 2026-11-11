import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { matchBottleText } from "./bottle-text";
import type { MatchListEntry } from "./name-match";
import type { RecognizedTextLine } from "./text-lines";

const line = (text: string, x = 0.5, y = 0.5, confidence = 1): RecognizedTextLine => ({ text, confidence, x, y });
const rec = (...texts: string[]): RecognizedTextLine[] => texts.map((t, i) => line(t, 0.5, 0.3 + i * 0.05));

const entries: MatchListEntry[] = [
  { shadeId: 1, name: "Suzi Takes A Sound Bath", aliases: ["NLF008"] },
  { shadeId: 2, name: "Latte" },
  { shadeId: 3, name: "Matcha Latte", aliases: ["2000344"] },
  { shadeId: 4, name: "Nail Polish" },
  { shadeId: 5, name: "Ox" },
  { shadeId: 6, name: "Cherry Bomb" },
];

describe("matchBottleText", () => {
  it("matches a name that wraps over two and three lines", () => {
    const two = matchBottleText({ recognitions: [rec("Suzi Takes", "A Sound Bath")], entries });
    assert.deepEqual(two.result, { kind: "matched", shadeId: 1, via: "name", rule: "exact", similarity: 1, lead: two.result.kind === "matched" ? two.result.lead : 0 });
    const three = matchBottleText({ recognitions: [rec("Suzi", "Takes A", "Sound Bath")], entries });
    assert.equal(three.result.kind === "matched" && three.result.shadeId, 1);
    const twoOnly = matchBottleText({ recognitions: [rec("Suzi", "Takes A", "Sound Bath")], entries, options: { text: { maxJoin: 2 } } });
    assert.notEqual(twoOnly.result.kind === "matched" && twoOnly.result.similarity, 1);
  });
  it("exact Latte matches Latte although Matcha Latte is in the list", () => {
    const m = matchBottleText({ recognitions: [rec("LATTE")], entries });
    assert.equal(m.result.kind === "matched" && m.result.shadeId, 2);
  });
  it("never matches a shade named Nail Polish from the text NAIL POLISH", () => {
    const m = matchBottleText({ recognitions: [rec("NAIL POLISH")], entries });
    assert.notEqual(m.result.kind === "matched" && m.result.shadeId, 4);
  });
  it("does not match a name below minChars", () => {
    assert.equal(matchBottleText({ recognitions: [rec("OX")], entries }).result.kind, "none");
  });
  it("ignores text outside the centre region", () => {
    const m = matchBottleText({ recognitions: [[line("Cherry Bomb", 0.05, 0.5)]], entries });
    assert.equal(m.result.kind, "none");
    const all = matchBottleText({ recognitions: [[line("Cherry Bomb", 0.05, 0.5)]], entries, options: { text: { region: null } } });
    assert.equal(all.result.kind === "matched" && all.result.shadeId, 6);
  });
  it("a vendor code that names one shade wins, letters or digits only", () => {
    const a = matchBottleText({ recognitions: [rec("NLF 008", "Shake well")], entries });
    assert.deepEqual(a.result, { kind: "matched", shadeId: 1, via: "code", rule: "code", similarity: 1, lead: 1 });
    assert.deepEqual(a.codeShadeIds, [1]);
    const b = matchBottleText({ recognitions: [[line("2000344", 0.5, 0.5)]], entries });
    assert.equal(b.result.kind === "matched" && b.result.shadeId, 3);
  });
  it("gives candidates when a code and a confident name disagree", () => {
    const m = matchBottleText({ recognitions: [rec("NLF008", "Cherry Bomb")], entries });
    assert.equal(m.result.kind, "candidates");
    if (m.result.kind === "candidates") {
      assert.deepEqual(m.result.ranked.map((c) => [c.shadeId, c.via]), [[1, "code"], [6, "name"]]);
    }
  });
  it("a code and the same shade's name agree", () => {
    const m = matchBottleText({ recognitions: [rec("NLF008", "Suzi Takes A Sound Bath")], entries });
    assert.equal(m.result.kind === "matched" && m.result.via, "code");
  });
  it("returns candidates for a near miss and none for noise", () => {
    const near = matchBottleText({ recognitions: [rec("Cherry Bom")], entries, options: { minLead: 0.95, minSimilarity: 0.99 } });
    assert.equal(near.result.kind, "candidates");
    assert.equal(matchBottleText({ recognitions: [rec("zzzzzz")], entries }).result.kind, "none");
  });
  it("extracts GTINs and rejects a wrong check digit", () => {
    const ok = matchBottleText({ recognitions: [rec("4006381333931")], entries });
    assert.deepEqual(ok.gtins, ["4006381333931"]);
    const bad = matchBottleText({ recognitions: [rec("4006381333932")], entries });
    assert.deepEqual(bad.gtins, []);
  });

  it("reports the rule: exact for an exact name, lead for a near one", () => {
    const exact = matchBottleText({ recognitions: [rec("Cherry Bomb")], entries });
    assert.equal(exact.result.kind === "matched" && exact.result.rule, "exact");
    const lead = matchBottleText({ recognitions: [rec("Cherry Bimb")], entries });
    assert.equal(lead.result.kind === "matched" && lead.result.rule, "lead");
  });
  it("never matches a name two shades carry: every owner is a candidate", () => {
    const twins: MatchListEntry[] = [
      { shadeId: 10, name: "Snow Much Fun" },
      { shadeId: 11, name: "Snow-Much Fun!" },
      { shadeId: 12, name: "Blizzard" },
    ];
    const m = matchBottleText({ recognitions: [rec("SNOW MUCH FUN")], entries: twins });
    assert.equal(m.result.kind, "candidates");
    if (m.result.kind === "candidates") assert.deepEqual(m.result.ranked.map((c) => c.shadeId), [10, 11]);
  });
  it("a read that is generic label text decides nothing, not even a near name", () => {
    const list: MatchListEntry[] = [{ shadeId: 1, name: "Nail Police" }, { shadeId: 2, name: "Nail Polish" }];
    assert.equal(matchBottleText({ recognitions: [rec("NAIL POLISH")], entries: list }).result.kind, "none");
  });
});
