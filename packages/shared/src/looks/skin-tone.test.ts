import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Polish } from "../types/polish";
import { SKIN_DEPTHS, SKIN_UNDERTONES, validateSavedLookInput, type SkinTone } from "../types/looks";
import { DEFAULT_VIBE, recommendLooks } from "./recommend";
import { skinToneAdjustment, skinToneFrom, SKIN_UNDERTONE_WEIGHT } from "./skin-tone";

function polish(id: string, hex: string, extra: Partial<Polish> = {}): Polish {
  return {
    id,
    shadeId: id,
    userId: "1",
    brand: "Brand",
    name: `Shade ${id}`,
    status: "owned",
    vendorHex: hex,
    finishes: ["creme"],
    createdAt: "",
    updatedAt: "",
    ...extra,
  } as Polish;
}

const HEXES = [
  "#E8D5C4", "#D9B8A0", "#F4C2C2", "#F7E7EC", "#FFFFFF", "#111111", "#B22222", "#8B1E3F", "#5B2245",
  "#1F3A93", "#3AA6B9", "#2E8B57", "#6A0DAD", "#C0C0C0", "#D4AF37", "#FF6F61", "#F5DEB3",
];
const COLLECTION = HEXES.map((hex, i) => polish(String(i + 1), hex));

function summary(vibe = DEFAULT_VIBE, seed = 1, skinTone?: SkinTone | null) {
  return recommendLooks({ polishes: COLLECTION, vibe, seed, skinTone }).looks.map(
    (l) => `${l.templateId}:${l.steps.map((s) => s.polish?.id ?? "-").join("/")}`
  );
}

describe("skin tone off", () => {
  // Frozen from the recommender before skin tone existed: no skin tone must never change a result.
  const FROZEN = ["french-modern:17/5", "office-neutral:2/5", "coral-pop:16/11"];

  it("matches the pre-skin-tone output for the same seed", () => {
    const actual = summary(DEFAULT_VIBE, 1);
    assert.deepEqual(actual, FROZEN);
    assert.deepEqual(summary(DEFAULT_VIBE, 1, null), actual);
    assert.deepEqual(summary({ ...DEFAULT_VIBE, skinTone: null }, 1), actual);
  });

  it("neutral undertone with medium depth adds nothing", () => {
    for (const hex of HEXES) assert.equal(skinToneAdjustment(hex, { undertone: "neutral", depth: "medium" }), 0);
    assert.equal(skinToneAdjustment("#FF0000", null), 0);
  });
});

describe("undertone", () => {
  it("cool prefers the blue–pink–berry side and warm the coral–orange–gold side", () => {
    const cool: SkinTone = { undertone: "cool", depth: "medium" };
    const warm: SkinTone = { undertone: "warm", depth: "medium" };
    const berry = "#8B1E3F";
    const blue = "#1F3A93";
    const coral = "#FF7A3D";
    const gold = "#D4AF37";
    for (const hex of [berry, blue]) {
      assert.ok(skinToneAdjustment(hex, cool) < 0, hex);
      assert.equal(skinToneAdjustment(hex, warm), 0, hex);
    }
    for (const hex of [coral, gold]) {
      assert.ok(skinToneAdjustment(hex, warm) < 0, hex);
      assert.equal(skinToneAdjustment(hex, cool), 0, hex);
    }
    assert.equal(skinToneAdjustment("#808080", cool), 0, "greys have no hue preference");
    assert.ok(Math.abs(skinToneAdjustment(blue, cool)) <= SKIN_UNDERTONE_WEIGHT);
  });

  it("flips the chosen base between a pink-leaning and an orange-leaning coral", () => {
    const polishes = [polish("1", "#F2677F"), polish("2", "#FF7A3D")];
    const base = (undertone: SkinTone["undertone"], seed: number) =>
      recommendLooks({
        polishes,
        vibe: { ...DEFAULT_VIBE, mood: "playful" },
        seed,
        count: 1,
        skinTone: { undertone, depth: "medium" },
      }).looks[0].steps.find((s) => s.role === "base")?.polish?.id;
    for (const seed of [1, 2, 3, 4, 5]) {
      assert.equal(base("cool", seed), "1", `cool seed ${seed}`);
      assert.equal(base("warm", seed), "2", `warm seed ${seed}`);
    }
  });

  it("never turns an owned polish into a catalog gap", () => {
    const withSkin = recommendLooks({ polishes: COLLECTION, vibe: DEFAULT_VIBE, seed: 1, skinTone: { undertone: "warm", depth: "deep" } });
    const without = recommendLooks({ polishes: COLLECTION, vibe: DEFAULT_VIBE, seed: 1 });
    assert.equal(withSkin.looks.length, without.looks.length);
    for (const look of withSkin.looks) assert.equal(look.steps[0].source, "owned");
  });

  it("keeps each template's identity", () => {
    const names = (skin?: SkinTone) => recommendLooks({ polishes: COLLECTION, vibe: DEFAULT_VIBE, seed: 1, skinTone: skin }).looks.map((l) => l.templateId);
    // The same templates rank first; the skin tone only reorders polishes inside them.
    assert.deepEqual(names({ undertone: "cool", depth: "fair" }).sort(), names().sort());
  });
});

describe("depth", () => {
  const paleNude = "#DCC3B0";
  const midRose = "#B5586B";
  const darkMuted = "#4A4044";
  const vivid = "#C2185B";

  it("fair and light move away from pale low-contrast nudes and toward mid tones", () => {
    for (const depth of ["fair", "light"] as const) {
      const skin: SkinTone = { undertone: "neutral", depth };
      assert.ok(skinToneAdjustment(paleNude, skin) > 0, `${depth} pale nude penalised`);
      assert.ok(skinToneAdjustment(midRose, skin) < 0, `${depth} mid tone preferred`);
    }
  });

  it("tan and deep move away from dark muted bases and toward higher chroma", () => {
    for (const depth of ["tan", "deep"] as const) {
      const skin: SkinTone = { undertone: "neutral", depth };
      assert.ok(skinToneAdjustment(vivid, skin) < skinToneAdjustment(darkMuted, skin), depth);
    }
    assert.ok(skinToneAdjustment(darkMuted, { undertone: "neutral", depth: "deep" }) > 0, "dark muted vanishes on deep skin");
    assert.equal(skinToneAdjustment(darkMuted, { undertone: "neutral", depth: "fair" }), 0);
  });

  it("medium is neutral", () => {
    for (const hex of [paleNude, midRose, darkMuted, vivid]) {
      assert.equal(skinToneAdjustment(hex, { undertone: "neutral", depth: "medium" }), 0);
    }
  });

  it("every combination still builds looks", () => {
    for (const undertone of SKIN_UNDERTONES) {
      for (const depth of SKIN_DEPTHS) {
        const looks = recommendLooks({ polishes: COLLECTION, vibe: DEFAULT_VIBE, seed: 2, skinTone: { undertone, depth } }).looks;
        assert.equal(looks.length, 3, `${undertone}/${depth}`);
      }
    }
  });
});

describe("skinToneFrom and saved looks", () => {
  it("fills the missing axis with no preference", () => {
    assert.equal(skinToneFrom(null, null), null);
    assert.deepEqual(skinToneFrom("warm", null), { undertone: "warm", depth: "medium" });
    assert.deepEqual(skinToneFrom(null, "deep"), { undertone: "neutral", depth: "deep" });
  });

  const base = {
    id: "office-neutral:1",
    templateId: "office-neutral",
    name: "Office Neutral",
    steps: [{ role: "base", label: "Base", hex: "#D8BFAA", source: "owned", shadeId: "1" }],
  };
  const vibe = { occasion: "work", mood: "soft", finish: null, ownedOnly: false };

  it("keeps snapshots without skin tone valid and round-trips one with it", () => {
    const old = validateSavedLookInput({ ...base, vibe });
    assert.ok(old.ok);
    assert.equal("skinTone" in old.look.vibe, false);
    const withSkin = validateSavedLookInput({ ...base, vibe: { ...vibe, skinTone: { undertone: "cool", depth: "tan" } } });
    assert.ok(withSkin.ok);
    assert.deepEqual(withSkin.look.vibe.skinTone, { undertone: "cool", depth: "tan" });
    const bad = validateSavedLookInput({ ...base, vibe: { ...vibe, skinTone: { undertone: "green", depth: "tan" } } });
    assert.ok(bad.ok);
    assert.equal(bad.look.vibe.skinTone, undefined);
  });
});
