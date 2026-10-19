import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Polish } from "swatchwatch-shared";
import { finishFamily, resolvePolishFinishes } from "swatchwatch-shared";
import {
  ACCENT_MIN_CONTRAST,
  DEFAULT_VIBE,
  LOOK_COUNT,
  LOOK_MIN_BASE_DISTANCE,
  LOOK_TEMPLATES,
  MAX_STEP_ALTERNATIVES,
  catalogQueriesForLooks,
  maniEntriesForLook,
  rankTemplatesForVibe,
  recommendLooks,
  type Vibe,
} from "./looks";
import { colorDistance } from "./color-utils";

let nextId = 1;
function polish(hex: string, extra: Partial<Polish> = {}): Polish {
  const id = String(nextId++);
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

/** A varied owned collection: neutrals, pinks, reds, berries, blues, greens, purples, metallics, toppers. */
function collection(): Polish[] {
  return [
    polish("#E8D5C4"), // nude
    polish("#D9B8A0"), // beige
    polish("#F4C2C2"), // pale pink
    polish("#F7E7EC", { finishes: ["sheer"] }), // milky
    polish("#FFFFFF"), // white
    polish("#111111"), // black
    polish("#B22222"), // red
    polish("#8B1E3F"), // berry
    polish("#5B2245"), // plum
    polish("#1F3A93"), // navy
    polish("#3AA6B9"), // teal
    polish("#2E8B57"), // green
    polish("#6A0DAD"), // purple
    polish("#C0C0C0", { finishes: ["metallic"] }), // silver chrome
    polish("#D4AF37", { finishes: ["metallic"] }), // gold
    polish("#E6E6FA", { finishes: ["topper"] }), // iridescent topper
    polish("#C9A0DC", { finishes: ["flake"] }), // flakie
    polish("#FF6F61"), // coral
    polish("#F5DEB3", { finishes: ["matte"] }), // matte nude
  ];
}

const vibe = (extra: Partial<Vibe> = {}): Vibe => ({ ...DEFAULT_VIBE, ...extra });

describe("LOOK_TEMPLATES", () => {
  it("has 15–20 templates with unique ids and valid hexes", () => {
    assert.ok(LOOK_TEMPLATES.length >= 15 && LOOK_TEMPLATES.length <= 20, `got ${LOOK_TEMPLATES.length}`);
    assert.equal(new Set(LOOK_TEMPLATES.map((t) => t.id)).size, LOOK_TEMPLATES.length);
    for (const template of LOOK_TEMPLATES) {
      assert.ok(template.steps.some((s) => s.role === "base"), `${template.id} needs a base`);
      for (const step of template.steps) assert.match(step.hex, /^#[0-9A-F]{6}$/, `${template.id}/${step.role}`);
    }
  });

  it("includes the named looks from the plan", () => {
    const names = new Set(LOOK_TEMPLATES.map((t) => t.name));
    for (const name of [
      "Glazed Donut",
      "Office Neutral",
      "Soft Chrome",
      "Galaxy Fade",
      "Cyber Violet",
      "Berry Gradient",
      "French Modern",
      "Monochrome Slick",
    ]) {
      assert.ok(names.has(name), name);
    }
  });
});

describe("rankTemplatesForVibe", () => {
  it("ranks templates matching occasion, mood and finish first", () => {
    const ranked = rankTemplatesForVibe(vibe({ occasion: "work", mood: "soft", finish: null }), 1);
    const top = ranked.slice(0, 5).map((t) => t.id);
    assert.ok(top.includes("office-neutral"), top.join(","));
    const chrome = rankTemplatesForVibe(vibe({ occasion: "party", mood: "bold", finish: "chrome" }), 1);
    assert.ok(chrome.slice(0, 5).some((t) => t.finishes.includes("chrome")));
  });

  it("is deterministic per seed", () => {
    const a = rankTemplatesForVibe(vibe(), 9).map((t) => t.id);
    assert.deepEqual(a, rankTemplatesForVibe(vibe(), 9).map((t) => t.id));
  });
});

describe("recommendLooks", () => {
  it("returns three looks whose bases are owned when the collection allows it", () => {
    const owned = collection();
    const result = recommendLooks({ polishes: owned, vibe: vibe(), seed: 1 });
    assert.equal(result.looks.length, LOOK_COUNT);
    assert.equal(result.shortfall, false);
    for (const look of result.looks) {
      const base = look.steps.find((s) => s.role === "base");
      assert.ok(base?.polish, `${look.templateId} base`);
      assert.equal(base.source, "owned");
    }
  });

  it("is reproducible per seed", () => {
    const owned = collection();
    const ids = (seed: number) =>
      recommendLooks({ polishes: owned, vibe: vibe(), seed }).looks.map(
        (l) => `${l.templateId}:${l.steps.map((s) => s.polish?.id ?? "-").join("/")}`
      );
    assert.deepEqual(ids(5), ids(5));
    const seen = new Set([1, 2, 3, 4, 5, 6, 7, 8].map((seed) => ids(seed).join("|")));
    assert.ok(seen.size > 1, "shuffling should change the looks");
  });

  it("never reuses a base and keeps bases apart (distance or finish family)", () => {
    for (const seed of [1, 2, 3, 4]) {
      const { looks } = recommendLooks({ polishes: collection(), vibe: vibe({ mood: "bold" }), seed });
      const bases = looks.map((l) => l.steps.find((s) => s.role === "base")!);
      assert.equal(new Set(looks.map((l) => l.templateId)).size, looks.length);
      for (let i = 0; i < bases.length; i++) {
        for (let j = i + 1; j < bases.length; j++) {
          assert.notEqual(bases[i].polish?.id ?? `t${i}`, bases[j].polish?.id ?? `t${j}`);
          const far = colorDistance(bases[i].hex, bases[j].hex) >= LOOK_MIN_BASE_DISTANCE;
          const famA = bases[i].polish ? finishFamily(resolvePolishFinishes(bases[i].polish!)[0] ?? "") : undefined;
          const famB = bases[j].polish ? finishFamily(resolvePolishFinishes(bases[j].polish!)[0] ?? "") : undefined;
          assert.ok(far || (famA && famB && famA !== famB), `seed ${seed}: bases ${i}/${j} too similar`);
        }
      }
    }
  });

  it("picks accents that contrast with the base", () => {
    const { looks } = recommendLooks({ polishes: collection(), vibe: vibe({ mood: "playful" }), seed: 3 });
    for (const look of looks) {
      const base = look.steps.find((s) => s.role === "base")!;
      const accent = look.steps.find((s) => s.role === "accent");
      if (accent?.polish) assert.ok(colorDistance(base.hex, accent.hex) >= ACCENT_MIN_CONTRAST, look.templateId);
    }
  });

  it("only uses owned polishes in owned-only mode, and says so when fewer than three looks fit", () => {
    const sparse = [polish("#E8D5C4"), polish("#B22222")];
    const result = recommendLooks({ polishes: sparse, vibe: vibe({ ownedOnly: true }), seed: 1 });
    assert.ok(result.looks.length < LOOK_COUNT);
    assert.equal(result.shortfall, true);
    for (const look of result.looks) {
      for (const step of look.steps) assert.equal(step.source, "owned", `${look.templateId}/${step.role}`);
    }
  });

  it("does not count wishlist or archived polishes as owned", () => {
    const notOwned = [
      polish("#E8D5C4", { status: "wishlist" }),
      polish("#B22222", { status: "archived" }),
    ];
    const result = recommendLooks({ polishes: notOwned, vibe: vibe({ ownedOnly: true }), seed: 1 });
    assert.equal(result.looks.length, 0);
    assert.equal(result.ownedCount, 0);
  });

  it("builds three template looks to buy when the user owns nothing", () => {
    const result = recommendLooks({ polishes: [], vibe: vibe(), seed: 1 });
    assert.equal(result.looks.length, LOOK_COUNT);
    for (const look of result.looks) {
      assert.equal(look.ownedSteps, 0);
      for (const step of look.steps) assert.notEqual(step.source, "owned");
    }
  });

  it("fills gaps from the catalog pool and marks them to add", () => {
    const catalogRow = polish("#F7E7EC", { status: undefined, brand: "Catalog", finishes: ["sheer"] });
    const result = recommendLooks({ polishes: [], catalog: [catalogRow], vibe: vibe({ mood: "soft" }), seed: 1 });
    const fromCatalog = result.looks.flatMap((l) => l.steps).filter((s) => s.source === "catalog");
    assert.ok(fromCatalog.length > 0);
    assert.ok(fromCatalog.every((s) => s.polish?.id === catalogRow.id));
  });

  it("never fills a gap with a catalog row the user already owns", () => {
    const owned = polish("#B22222");
    const result = recommendLooks({ polishes: [owned], catalog: [owned], vibe: vibe(), seed: 1 });
    for (const step of result.looks.flatMap((l) => l.steps)) {
      if (step.polish?.id === owned.id) assert.equal(step.source, "owned");
    }
  });

  it("prefers a base with the requested finish", () => {
    const creme = polish("#E8D5C4");
    const matte = polish("#E0C9B5", { finishes: ["matte"] });
    const result = recommendLooks({
      polishes: [creme, matte],
      vibe: vibe({ occasion: "work", mood: "soft", finish: "matte" }),
      seed: 1,
    });
    const bases = result.looks.map((l) => l.steps.find((s) => s.role === "base")!.polish?.id);
    assert.equal(bases[0], matte.id);
  });

  it("uses an owned topper and skips toppers over a glitter base", () => {
    const owned = collection();
    const { looks } = recommendLooks({ polishes: owned, vibe: vibe({ finish: "flake" }), seed: 2 });
    const toppers = looks.flatMap((l) => l.steps).filter((s) => s.role === "topper" && s.polish);
    assert.ok(toppers.length > 0, "expected a topper step");
    for (const step of toppers) {
      const finishes = resolvePolishFinishes(step.polish!);
      assert.ok(finishes.some((f) => ["topper", "flake", "glitter"].includes(f)), finishes.join(","));
    }

    const glitterBase = polish("#C0C0C0", { finishes: ["glitter"] });
    const topper = polish("#E6E6FA", { finishes: ["topper"] });
    const glitterResult = recommendLooks({
      polishes: [glitterBase, topper],
      vibe: vibe({ occasion: "party", mood: "bold", finish: null }),
      seed: 1,
    });
    for (const look of glitterResult.looks) {
      const base = look.steps.find((s) => s.role === "base");
      if (base?.polish?.id === glitterBase.id) {
        assert.ok(!look.steps.some((s) => s.role === "topper" && s.polish?.id === topper.id), look.templateId);
      }
    }
  });

  it("offers up to three owned alternatives per step, never the chosen polish", () => {
    const { looks } = recommendLooks({ polishes: collection(), vibe: vibe(), seed: 1 });
    for (const step of looks.flatMap((l) => l.steps)) {
      assert.ok(step.alternatives.length <= MAX_STEP_ALTERNATIVES);
      assert.ok(step.alternatives.every((alt) => alt.id !== step.polish?.id && alt.status === "owned"));
    }
    assert.ok(looks.some((l) => l.steps.some((s) => s.alternatives.length > 0)));
  });
});

describe("maniEntriesForLook", () => {
  it("maps owned steps to manicure roles and skips steps to add", () => {
    const owned = collection();
    const result = recommendLooks({ polishes: owned, vibe: vibe(), seed: 1 });
    const look = result.looks[0];
    const entries = maniEntriesForLook(look);
    const ownedSteps = look.steps.filter((s) => s.source === "owned");
    assert.equal(entries.length, ownedSteps.length);
    for (const entry of entries) {
      const step = look.steps.find((s) => s.polish?.id === entry.shadeId)!;
      assert.equal(entry.role, step.role === "base" ? "color" : step.role);
    }
  });
});

describe("catalogQueriesForLooks", () => {
  it("asks for the color family of each missing color step and topper finishes for a missing topper", () => {
    const result = recommendLooks({ polishes: [], vibe: vibe({ finish: "flake" }), seed: 1 });
    const queries = catalogQueriesForLooks(result.looks);
    assert.ok(queries.families.length > 0);
    assert.equal(new Set(queries.families).size, queries.families.length);
    assert.equal(queries.toppers, result.looks.some((l) => l.steps.some((s) => s.role === "topper")));
  });

  it("asks for nothing when every step is owned", () => {
    assert.deepEqual(catalogQueriesForLooks([]), { families: [], toppers: false });
  });
});
