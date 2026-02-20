import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Polish } from "swatchwatch-shared";
import { undertone } from "./color-utils";
import {
  buildBrandOptions,
  filterPolishesForList,
  matchesBrandFilter,
} from "./polish-filters";

function polish(overrides: Partial<Polish>): Polish {
  return {
    id: "1",
    shadeId: "1",
    userId: "1",
    brand: "Zoya",
    name: "Default",
    color: "Default",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildBrandOptions", () => {
  it("returns empty array for empty input", () => {
    assert.deepEqual(buildBrandOptions([]), []);
  });

  it("deduplicates by case/whitespace and returns lexicographically sorted values", () => {
    const options = buildBrandOptions([
      { brand: "Zoya" },
      { brand: " zOya " },
      { brand: "OPI" },
      { brand: "Essie" },
    ]);

    assert.deepEqual(options, ["Essie", "OPI", "Zoya"]);
  });
});

describe("matchesBrandFilter", () => {
  it("matches brand values case/whitespace insensitively", () => {
    assert.equal(matchesBrandFilter(" Zoya ", "zOYA"), true);
    assert.equal(matchesBrandFilter("Zoya", "OPI"), false);
  });
});

describe("filterPolishesForList", () => {
  const polishes = [
    polish({
      id: "name",
      brand: "Zoya",
      name: "Aurora",
      color: "Berry",
      collection: "PixieDust",
      notes: "rainbow sparkle",
      finish: "holographic",
      quantity: 2,
      vendorHex: "#8B1E7A",
    }),
    polish({
      id: "brand",
      brand: "Essie",
      name: "Ballet Slippers",
      color: "Pale Pink",
      finish: "creme",
      quantity: 0,
      detectedHex: "#F8D5E1",
    }),
    polish({
      id: "collection",
      brand: "ILNP",
      name: "Eclipse",
      color: "Black Red",
      collection: "Ultra Chrome",
      notes: "dramatic shift",
      finish: "multichrome",
      quantity: 1,
      nameHex: "#2D1016",
    }),
  ];

  it("matches search across name/brand/color/collection/notes", () => {
    const byName = filterPolishesForList({
      polishes,
      search: "aurora",
      includeAll: true,
      toneFilter: "all",
      brandFilter: "all",
      finishFilter: "all",
      availabilityFilter: "all",
    });
    const byBrand = filterPolishesForList({
      polishes,
      search: "essie",
      includeAll: true,
      toneFilter: "all",
      brandFilter: "all",
      finishFilter: "all",
      availabilityFilter: "all",
    });
    const byColor = filterPolishesForList({
      polishes,
      search: "black red",
      includeAll: true,
      toneFilter: "all",
      brandFilter: "all",
      finishFilter: "all",
      availabilityFilter: "all",
    });
    const byCollection = filterPolishesForList({
      polishes,
      search: "pixiedust",
      includeAll: true,
      toneFilter: "all",
      brandFilter: "all",
      finishFilter: "all",
      availabilityFilter: "all",
    });
    const byNotes = filterPolishesForList({
      polishes,
      search: "dramatic",
      includeAll: true,
      toneFilter: "all",
      brandFilter: "all",
      finishFilter: "all",
      availabilityFilter: "all",
    });

    assert.deepEqual(byName.map((p) => p.id), ["name"]);
    assert.deepEqual(byBrand.map((p) => p.id), ["brand"]);
    assert.deepEqual(byColor.map((p) => p.id), ["collection"]);
    assert.deepEqual(byCollection.map((p) => p.id), ["name"]);
    assert.deepEqual(byNotes.map((p) => p.id), ["collection"]);
  });

  it("uses vendorHex, then detectedHex, then nameHex for tone filtering", () => {
    const vendorTone = undertone(polishes[0].vendorHex!);
    const detectedTone = undertone(polishes[1].detectedHex!);
    const nameTone = undertone(polishes[2].nameHex!);

    const vendorResult = filterPolishesForList({
      polishes,
      search: "",
      includeAll: true,
      toneFilter: vendorTone,
      brandFilter: "all",
      finishFilter: "all",
      availabilityFilter: "all",
    });
    const detectedResult = filterPolishesForList({
      polishes,
      search: "",
      includeAll: true,
      toneFilter: detectedTone,
      brandFilter: "all",
      finishFilter: "all",
      availabilityFilter: "all",
    });
    const nameResult = filterPolishesForList({
      polishes,
      search: "",
      includeAll: true,
      toneFilter: nameTone,
      brandFilter: "all",
      finishFilter: "all",
      availabilityFilter: "all",
    });

    assert.ok(vendorResult.some((p) => p.id === "name"));
    assert.ok(detectedResult.some((p) => p.id === "brand"));
    assert.ok(nameResult.some((p) => p.id === "collection"));
  });

  it("applies brand, finish, availability, and includeAll correctly", () => {
    const brandFiltered = filterPolishesForList({
      polishes,
      search: "",
      includeAll: true,
      toneFilter: "all",
      brandFilter: " zOya ",
      finishFilter: "all",
      availabilityFilter: "all",
    });
    assert.deepEqual(brandFiltered.map((p) => p.id), ["name"]);

    const finishFiltered = filterPolishesForList({
      polishes,
      search: "",
      includeAll: true,
      toneFilter: "all",
      brandFilter: "all",
      finishFilter: "multichrome",
      availabilityFilter: "all",
    });
    assert.deepEqual(finishFiltered.map((p) => p.id), ["collection"]);

    const ownedOnly = filterPolishesForList({
      polishes,
      search: "",
      includeAll: false,
      toneFilter: "all",
      brandFilter: "all",
      finishFilter: "all",
      availabilityFilter: "all",
    });
    assert.deepEqual(ownedOnly.map((p) => p.id), ["name", "collection"]);

    const wishlistTakesPrecedence = filterPolishesForList({
      polishes,
      search: "",
      includeAll: false,
      toneFilter: "all",
      brandFilter: "all",
      finishFilter: "all",
      availabilityFilter: "wishlist",
    });
    assert.deepEqual(wishlistTakesPrecedence.map((p) => p.id), ["brand"]);
  });

  it("intersects multiple filters", () => {
    const result = filterPolishesForList({
      polishes,
      search: "ultra",
      includeAll: true,
      toneFilter: undertone(polishes[2].nameHex!),
      brandFilter: " ilnp ",
      finishFilter: "multichrome",
      availabilityFilter: "owned",
    });

    assert.deepEqual(result.map((p) => p.id), ["collection"]);
  });
});
