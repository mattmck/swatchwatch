import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Polish } from "swatchwatch-shared";
import type { Look, LookStep } from "./looks";
import { DEFAULT_VIBE } from "./looks";
import {
  applicationOrder,
  finishNotes,
  formatShoppingSubtotals,
  shoppingSubtotals,
  lookShareText,
  shoppingItemsForLook,
  shoppingListText,
  skinToneBackdrop,
  SKIN_TONE_COOL,
  SKIN_TONE_WARM,
} from "./looks-detail";
import { DEFAULT_LOOKS_STATE, buildLooksQueryString, lookShareUrl } from "./looks-url";

function polish(id: string, name: string, extra: Partial<Polish> = {}): Polish {
  return { id, shadeId: id, brand: "Brand", name, vendorHex: "#E8D5C4", finishes: ["creme"], status: "owned", ...extra } as Polish;
}

function step(role: LookStep["role"], label: string, p: Polish | null, source: LookStep["source"], hex = "#E8D5C4"): LookStep {
  return { role, label, targetHex: hex, hex, polish: p, source, distance: p ? 0.02 : null, alternatives: [] };
}

function look(steps: LookStep[]): Look {
  const ownedSteps = steps.filter((s) => s.source === "owned").length;
  return {
    templateId: "office-neutral",
    name: "Office Neutral",
    description: "",
    difficulty: "easy",
    minutes: 15,
    steps,
    ownedSteps,
    missingSteps: steps.length - ownedSteps,
  };
}

const owned = polish("1", "Ballet Slippers", { brand: "Essie" });
const catalog = polish("2", "Willa", { brand: "Zoya", status: undefined, buyUrl: "https://zoya.example/willa" });
const mixed = look([
  step("base", "Base", owned, "owned"),
  step("accent", "Accent nail", catalog, "catalog", "#A8846A"),
  step("topper", "Topper", null, "template", "#E6E6FA"),
]);

describe("shoppingItemsForLook", () => {
  it("lists only steps you don't own, with wishlistability and a safe buy link", () => {
    const items = shoppingItemsForLook(mixed);
    assert.deepEqual(items.map((i) => i.role), ["accent", "topper"]);
    assert.equal(items[0].shadeId, "2");
    assert.equal(items[0].buyUrl, "https://zoya.example/willa");
    assert.equal(items[0].canWishlist, true);
    assert.equal(items[1].canWishlist, false);
    assert.equal(items[1].buyUrl, null);
  });

  it("drops an unsafe buy link", () => {
    const bad = look([step("base", "Base", { ...catalog, buyUrl: "javascript:alert(1)" } as Polish, "catalog")]);
    assert.equal(shoppingItemsForLook(bad)[0].buyUrl, null);
  });

  it("is empty for a fully owned look", () => {
    assert.deepEqual(shoppingItemsForLook(look([step("base", "Base", owned, "owned")])), []);
  });
});

describe("shoppingListText", () => {
  it("is a plain, copyable list with brand, name and link, and a color hint for template steps", () => {
    const text = shoppingListText(mixed);
    assert.match(text, /^Shopping list for Office Neutral/);
    assert.match(text, /Accent nail: Willa — Zoya \(https:\/\/zoya\.example\/willa\)/);
    assert.match(text, /Topper: any shade close to #E6E6FA/);
    assert.ok(!text.includes("Ballet Slippers"), "owned steps are not on the list");
  });
});

describe("shopping list prices", () => {
  const priced = (id: string, extra: Partial<Polish>) =>
    polish(id, `Shade ${id}`, { status: undefined, buyUrl: `https://brand.example/${id}`, ...extra });
  const pricedLook = look([
    step("base", "Base", priced("10", { buyPrice: 14, buyCurrency: "USD", buyPriceSeenAt: "2026-10-21T00:00:00.000Z" }), "catalog"),
    step("accent", "Accent nail", priced("11", { buyPrice: 9.5, buyCurrency: "USD" }), "catalog"),
    step("topper", "Topper", priced("12", { buyPrice: 12, buyCurrency: "EUR" }), "catalog"),
    step("accent", "Tip", priced("13", {}), "catalog"),
    step("topper", "Glitter", null, "template"),
  ]);

  it("carries each item's price only with a safe buy link", () => {
    const items = shoppingItemsForLook(pricedLook);
    assert.deepEqual(items[0].price, { amount: 14, currency: "USD" });
    assert.equal(items[0].priceSeenAt, "2026-10-21T00:00:00.000Z");
    assert.equal(items[3].price, null);
    const unsafe = look([step("base", "Base", priced("14", { buyUrl: "javascript:alert(1)", buyPrice: 5, buyCurrency: "USD" }), "catalog")]);
    assert.equal(shoppingItemsForLook(unsafe)[0].price, null);
  });

  it("subtotals per currency and never sums across currencies", () => {
    const { subtotals, unpricedCount } = shoppingSubtotals(shoppingItemsForLook(pricedLook));
    assert.deepEqual(subtotals, [
      { currency: "USD", total: 23.5, count: 2 },
      { currency: "EUR", total: 12, count: 1 },
    ]);
    assert.equal(unpricedCount, 2);
    const text = formatShoppingSubtotals(subtotals);
    assert.ok(text?.includes("23.50") && text.includes("12.00"), text ?? "");
    assert.equal(formatShoppingSubtotals([]), null);
  });

  it("puts prices and the subtotal in the copyable text", () => {
    const text = shoppingListText(pricedLook);
    assert.match(text, /Base: Shade 10 — Brand, \S*14\.00\S* \(https:\/\/brand\.example\/10\)/);
    assert.match(text, /Tip: Shade 13 — Brand \(https:\/\/brand\.example\/13\)/);
    assert.match(text, /Subtotal \(brand list prices\): \S*23\.50\S* · \S*12\.00\S*$/);
  });
});

describe("lookShareText", () => {
  it("summarizes the look and ends with the link, marking what is owned", () => {
    const url = "https://app.example/polishes/looks/?occasion=work&seed=3";
    const text = lookShareText(mixed, { ...DEFAULT_VIBE, occasion: "work", mood: "bold" }, url);
    const lines = text.split("\n");
    assert.equal(lines[0], "Office Neutral — Work · Bold");
    assert.ok(lines.includes("Base: Ballet Slippers (Essie)"));
    assert.ok(lines.includes("Accent nail: Willa (Zoya) — to add"));
    assert.ok(lines.includes("Topper: any shade close to #E6E6FA — to add"));
    assert.equal(lines.at(-1), url);
  });
});

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

describe("applicationOrder", () => {
  it("runs base coat, base color, accent, topper, top coat in order", () => {
    const steps = applicationOrder(mixed);
    assert.deepEqual(steps.map((s) => s.kind), ["base-coat", "base", "accent", "topper", "top-coat"]);
    assert.match(steps[1].text, /Ballet Slippers/);
    assert.match(steps[3].text, /any shade close to #E6E6FA/);
  });

  it("uses a matte top coat when any polish is matte, and a glossy one otherwise", () => {
    const matteLook = look([step("base", "Base", polish("3", "Velvet", { finishes: ["matte"] }), "owned")]);
    assert.match(applicationOrder(matteLook).at(-1)!.text, /matte/i);
    assert.match(applicationOrder(mixed).at(-1)!.text, /gloss/i);
  });
});

describe("finishNotes", () => {
  it("adds one note per distinct finish present, none for plain cremes", () => {
    const l = look([
      step("base", "Base", polish("4", "Holo", { finishes: ["holographic"] }), "owned"),
      step("accent", "Accent", polish("5", "Holo2", { finishes: ["holographic"] }), "owned"),
      step("topper", "Topper", polish("6", "Flakes", { finishes: ["flake"] }), "owned"),
      step("accent", "Plain", polish("7", "Creme", { finishes: ["creme"] }), "owned"),
    ]);
    const notes = finishNotes(l);
    assert.deepEqual(notes.map((n) => n.finish), ["holographic", "flake"]);
    assert.ok(notes.every((n) => n.note.length > 10));
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
