import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LOOKS_STATE, buildLooksQueryString, parseLooksState } from "./looks-url";

const parse = (qs: string) => parseLooksState(new URLSearchParams(qs));

describe("parseLooksState", () => {
  it("defaults to everyday + soft, any finish, not owned-only, seed 1", () => {
    assert.deepEqual(parse(""), DEFAULT_LOOKS_STATE);
    assert.deepEqual(DEFAULT_LOOKS_STATE, {
      vibe: { occasion: "everyday", mood: "soft", finish: null, ownedOnly: false },
      seed: 1,
    });
  });

  it("reads every field", () => {
    assert.deepEqual(parse("occasion=party&mood=edgy&finish=chrome&owned=1&seed=42"), {
      vibe: { occasion: "party", mood: "edgy", finish: "chrome", ownedOnly: true },
      seed: 42,
    });
  });

  it("falls back on unknown values", () => {
    assert.deepEqual(parse("occasion=brunch&mood=SOFT&finish=velvet&owned=maybe&seed=-3"), DEFAULT_LOOKS_STATE);
    assert.equal(parse("mood=Bold").vibe.mood, "bold");
    assert.equal(parse("owned=true").vibe.ownedOnly, true);
  });
});

describe("buildLooksQueryString", () => {
  it("omits defaults", () => {
    assert.equal(buildLooksQueryString(DEFAULT_LOOKS_STATE), "");
  });

  it("round-trips", () => {
    const state = { vibe: { occasion: "work", mood: "bold", finish: "matte", ownedOnly: true }, seed: 7 } as const;
    const qs = buildLooksQueryString(state);
    assert.equal(qs, "occasion=work&mood=bold&finish=matte&owned=1&seed=7");
    assert.deepEqual(parse(qs), state);
  });
});
