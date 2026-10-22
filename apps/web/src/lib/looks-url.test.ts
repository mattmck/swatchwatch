import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LOOKS_STATE, buildLooksQueryString, lookColorLabHref, parseLooksState } from "./looks-url";
import { parseColorSearchState } from "./color-search-url";

const parse = (qs: string) => parseLooksState(new URLSearchParams(qs));

describe("parseLooksState", () => {
  it("defaults to everyday + soft, any finish, not owned-only, seed 1", () => {
    assert.deepEqual(parse(""), DEFAULT_LOOKS_STATE);
    assert.deepEqual(DEFAULT_LOOKS_STATE, {
      vibe: { occasion: "everyday", mood: "soft", finish: null, ownedOnly: false },
      seed: 1,
      toppers: true,
    });
  });

  it("reads every field", () => {
    assert.deepEqual(parse("occasion=party&mood=edgy&finish=chrome&owned=1&toppers=0&seed=42"), {
      vibe: { occasion: "party", mood: "edgy", finish: "chrome", ownedOnly: true },
      seed: 42,
      toppers: false,
    });
  });

  it("falls back on unknown values", () => {
    assert.deepEqual(parse("occasion=brunch&mood=SOFT&finish=velvet&owned=maybe&seed=-3"), DEFAULT_LOOKS_STATE);
    assert.equal(parse("mood=Bold").vibe.mood, "bold");
    assert.equal(parse("owned=true").vibe.ownedOnly, true);
  });

  it("keeps toppers on unless toppers=0 or false (links made before the toggle keep their looks, #386)", () => {
    assert.equal(parse("").toppers, true);
    assert.equal(parse("toppers=1").toppers, true);
    assert.equal(parse("toppers=maybe").toppers, true);
    assert.equal(parse("toppers=0").toppers, false);
    assert.equal(parse("toppers=FALSE").toppers, false);
  });
});

describe("buildLooksQueryString", () => {
  it("omits defaults", () => {
    assert.equal(buildLooksQueryString(DEFAULT_LOOKS_STATE), "");
  });

  it("round-trips", () => {
    const state = { vibe: { occasion: "work", mood: "bold", finish: "matte", ownedOnly: true }, seed: 7, toppers: false } as const;
    const qs = buildLooksQueryString(state);
    assert.equal(qs, "occasion=work&mood=bold&finish=matte&owned=1&toppers=0&seed=7");
    assert.deepEqual(parse(qs), state);
  });
});

describe("lookColorLabHref (#386)", () => {
  const steps = [
    { role: "base", hex: "#f4c2c2" },
    { role: "accent", hex: "#B22222" },
    { role: "topper", hex: "#E6E6FA" },
  ] as const;

  it("seeds color search with the base color, every step hex as a focused color, and returnTo", () => {
    const href = lookColorLabHref(steps, "/polishes/looks?mood=bold&toppers=0&seed=4");
    assert.ok(href.startsWith("/polishes/search?"), href);
    const state = parseColorSearchState(new URLSearchParams(href.split("?")[1]));
    assert.equal(state.color, "#F4C2C2");
    assert.deepEqual(state.paletteAnchors, ["#F4C2C2", "#B22222", "#E6E6FA"]);
    assert.equal(state.returnTo, "/polishes/looks?mood=bold&toppers=0&seed=4");
    assert.equal(state.harmony, "all");
  });

  it("deduplicates hexes, skips invalid ones and drops an unsafe returnTo", () => {
    const href = lookColorLabHref(
      [
        { role: "base", hex: "#111111" },
        { role: "accent", hex: "#111111" },
        { role: "topper", hex: "sparkle" },
      ],
      "//evil.example"
    );
    const state = parseColorSearchState(new URLSearchParams(href.split("?")[1]));
    assert.deepEqual(state.paletteAnchors, ["#111111"]);
    assert.equal(state.returnTo, null);
  });
});
