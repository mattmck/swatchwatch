import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { skinToneBackdrop, skinToneBackdropFor, SKIN_TONE_COOL, SKIN_TONE_WARM } from "./looks-detail";
import { DEFAULT_LOOKS_STATE, buildLooksQueryString, lookShareUrl } from "./looks-url";

describe("lookShareUrl", () => {
  it("is the page URL with the vibe and seed, nothing personal", () => {
    const state = { vibe: { occasion: "party", mood: "edgy", finish: "chrome", ownedOnly: true }, seed: 9, toppers: false } as const;
    assert.equal(
      lookShareUrl("https://app.example", "/polishes/looks/", state),
      `https://app.example/polishes/looks/?${buildLooksQueryString(state)}`
    );
    assert.equal(lookShareUrl("https://app.example", "/polishes/looks/", DEFAULT_LOOKS_STATE), "https://app.example/polishes/looks/");
  });
});

describe("skinToneBackdrop", () => {
  it("interpolates between the cool and warm ends and clamps", () => {
    assert.equal(skinToneBackdrop(0), SKIN_TONE_COOL);
    assert.equal(skinToneBackdrop(100), SKIN_TONE_WARM);
    assert.equal(skinToneBackdrop(-20), SKIN_TONE_COOL);
    assert.equal(skinToneBackdrop(500), SKIN_TONE_WARM);
    assert.match(skinToneBackdrop(50), /^#[0-9A-F]{6}$/);
    assert.notEqual(skinToneBackdrop(50), SKIN_TONE_COOL);
  });
});

describe("skinToneBackdropFor", () => {
  it("follows the undertone and shifts lighter or deeper with the depth", () => {
    assert.equal(skinToneBackdropFor({ undertone: "cool", depth: "medium" }), SKIN_TONE_COOL);
    assert.equal(skinToneBackdropFor({ undertone: "warm", depth: "medium" }), SKIN_TONE_WARM);
    const lum = (hex: string) => [1, 3, 5].reduce((sum, i) => sum + Number.parseInt(hex.slice(i, i + 2), 16), 0);
    const fair = lum(skinToneBackdropFor({ undertone: "neutral", depth: "fair" }));
    const medium = lum(skinToneBackdropFor({ undertone: "neutral", depth: "medium" }));
    const deep = lum(skinToneBackdropFor({ undertone: "neutral", depth: "deep" }));
    assert.ok(fair > medium && medium > deep);
  });
});
