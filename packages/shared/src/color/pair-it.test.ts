import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Polish } from "../types/polish";
import { generateHarmonyPalette } from "./harmonies";
import { PAIR_MAX_DISTANCE, pairableDisplayHex, suggestPairings } from "./pair-it";

function polish(id: string, extra: Partial<Polish> = {}): Polish {
  return {
    id,
    shadeId: id,
    userId: "1",
    brand: "Brand",
    name: `Shade ${id}`,
    status: "owned",
    vendorHex: "#C0392B",
    createdAt: "",
    updatedAt: "",
    ...extra,
  } as Polish;
}

describe("suggestPairings", () => {
  const pick = polish("pick", { vendorHex: "#1F4E9C" }); // blue
  const complementHex = generateHarmonyPalette("#1F4E9C", "complementary")[1];
  const analogousHex = generateHarmonyPalette("#1F4E9C", "analogous")[2];

  it("suggests the complementary and analogous owned polishes plus a topper, at most 2", () => {
    const collection = [
      pick,
      polish("complement", { vendorHex: complementHex }),
      polish("analogous", { vendorHex: analogousHex }),
      polish("glitter", { vendorHex: "#DDDDDD", finishes: ["glitter"], wearCount: 1 }),
      polish("topper", { vendorHex: "#EEEEEE", finishes: ["topper"], wearCount: 4 }),
      polish("far", { vendorHex: "#1F4E9D", status: "wishlist" }),
    ];
    const pairs = suggestPairings(pick, collection);
    assert.equal(pairs.length, 2);
    assert.ok(["complement", "analogous"].includes(pairs[0].polish.id));
    assert.equal(pairs[1].polish.id, "topper", "a `topper` finish beats glitter");
    assert.equal(pairs[1].role, "topper");
    assert.equal(pairs[0].role, "accent");

    const three = suggestPairings(pick, collection, 3);
    assert.deepEqual(new Set(three.map((p) => p.harmony)), new Set(["complementary", "analogous", "topper"]));
    const complement = three.find((p) => p.harmony === "complementary")!;
    assert.equal(complement.polish.id, "complement");
    assert.ok((complement.distance ?? 1) < 0.02);
    assert.deepEqual(suggestPairings(pick, collection, 0), []);
  });

  it("returns nothing when no owned polish is close enough and there are no toppers", () => {
    const collection = [pick, polish("nearly-same", { vendorHex: "#1F4E9D" })];
    assert.deepEqual(suggestPairings(pick, collection), []);
    assert.deepEqual(suggestPairings(pick, [pick]), []);
  });

  it("ignores matches further than PAIR_MAX_DISTANCE", () => {
    // A green is far from both the blue's complement (amber) and its analogous neighbours.
    const collection = [pick, polish("green", { vendorHex: "#2ECC40" })];
    assert.deepEqual(suggestPairings(pick, collection), []);
    assert.equal(PAIR_MAX_DISTANCE, 0.12);
  });

  it("skips hue harmonies for neutral picks and topper suggestions for topper picks", () => {
    const gray = polish("gray", { vendorHex: "#808080" });
    const red = polish("red", { vendorHex: "#C0392B" });
    const topper = polish("topper", { vendorHex: "#EEEEEE", finishes: ["topper"] });
    assert.deepEqual(
      suggestPairings(gray, [gray, red, topper]).map((p) => p.harmony),
      ["topper"]
    );
    const topperPick = polish("tp", { vendorHex: "#C0392B", finishes: ["topper"] });
    assert.ok(suggestPairings(topperPick, [topperPick, topper]).every((p) => p.harmony !== "topper"));
  });

  it("labels a glitter/flake accent as a sparkle accent", () => {
    const glitter = polish("glitter", { vendorHex: "#DDDDDD", finishes: ["glitter"] });
    const [pair] = suggestPairings(polish("gray", { vendorHex: "#808080" }), [glitter]);
    assert.equal(pair.role, "accent");
    assert.equal(pair.label, "Sparkle accent");
  });
});

describe("suggestPairings — product categories (#349, D-C)", () => {
  const collection = [
    polish("color", { vendorHex: "#C0392B" }),
    polish("topper", { productCategory: "topper", vendorHex: "#F4F4F2", finishes: ["glitter"] }),
    polish("top-coat", { productCategory: "top_coat", vendorHex: "#F5F5F5" }),
    polish("base-coat", { productCategory: "base_coat", vendorHex: "#F6F6F6" }),
    polish("treatment", { productCategory: "treatment" }),
    polish("accessory", { productCategory: "accessory" }),
  ];

  it("pairs a topper by category (even without a topper finish) and never a coat or accessory", () => {
    const pairings = suggestPairings(collection[0], collection);
    const ids = pairings.map((pairing) => pairing.polish.id);
    assert.ok(ids.includes("topper"), "the topper is suggested");
    assert.ok(!ids.some((id) => ["top-coat", "base-coat", "treatment", "accessory"].includes(id)));
    const topper = pairings.find((pairing) => pairing.polish.id === "topper");
    assert.equal(topper?.role, "topper");
    assert.equal(topper?.label, "Topper");
  });
});

describe("pairableDisplayHex", () => {
  it("returns vendor > detected > name, only for valid #RRGGBB", () => {
    assert.equal(pairableDisplayHex({ vendorHex: "#ABCDEF", detectedHex: "#000000" }), "#ABCDEF");
    assert.equal(pairableDisplayHex({ detectedHex: "#123456" }), "#123456");
    assert.equal(pairableDisplayHex({ vendorHex: "red" }), undefined);
    assert.equal(pairableDisplayHex({}), undefined);
  });
});
