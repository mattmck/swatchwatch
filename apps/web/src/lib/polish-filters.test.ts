import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Polish } from "swatchwatch-shared";
import { undertone } from "./color-utils";
import {
  buildBrandOptions,
  filterPolishesForList,
  matchesBrandFilter,
  matchesFinishFilter,
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
      status: "owned",
      vendorHex: "#8B1E7A",
    }),
    polish({
      id: "brand",
      brand: "Essie",
      name: "Ballet Slippers",
      color: "Pale Pink",
      finish: "creme",
      quantity: 0,
      status: "wishlist",
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
      status: "owned",
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

  it("derives ownership and wishlist from status, not quantity (issue #261)", () => {
    const rows = [
      polish({ id: "owned", status: "owned", quantity: 0 }),
      polish({ id: "wishlist", status: "wishlist", quantity: 2 }),
      polish({ id: "destash", status: "destash", quantity: 1 }),
      polish({ id: "catalog" }),
    ];
    const base = {
      polishes: rows,
      search: "",
      toneFilter: "all" as const,
      brandFilter: "all",
      finishFilter: "all",
    };
    assert.deepEqual(
      filterPolishesForList({ ...base, includeAll: false, availabilityFilter: "all" }).map((p) => p.id),
      ["owned"]
    );
    assert.deepEqual(
      filterPolishesForList({ ...base, includeAll: true, availabilityFilter: "owned" }).map((p) => p.id),
      ["owned"]
    );
    assert.deepEqual(
      filterPolishesForList({ ...base, includeAll: true, availabilityFilter: "wishlist" }).map((p) => p.id),
      ["wishlist"],
      "catalog rows and other statuses are not on the wishlist"
    );
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

describe("matchesFinishFilter (multi-finish)", () => {
  it("matches any finish in the finishes array, case-insensitively", () => {
    const p = polish({ finish: "shimmer", finishes: ["shimmer", "holographic"] });
    assert.equal(matchesFinishFilter(p, "holographic"), true);
    assert.equal(matchesFinishFilter(p, "SHIMMER"), true);
    assert.equal(matchesFinishFilter(p, "creme"), false);
  });

  it("falls back to the legacy single finish when finishes is empty", () => {
    assert.equal(matchesFinishFilter(polish({ finish: "creme", finishes: [] }), "creme"), true);
    assert.equal(matchesFinishFilter(polish({ finish: "creme" }), "creme"), true);
    assert.equal(matchesFinishFilter(polish({}), "creme"), false);
  });

  it("filterPolishesForList keeps multi-finish shades for any of their finishes", () => {
    const rows = [
      polish({ id: "a", quantity: 1, status: "owned", finish: "shimmer", finishes: ["shimmer", "holographic"] }),
      polish({ id: "b", quantity: 1, status: "owned", finish: "holographic" }),
      polish({ id: "c", quantity: 1, status: "owned", finish: "creme", finishes: ["creme"] }),
    ];
    const result = filterPolishesForList({
      polishes: rows,
      search: "",
      includeAll: true,
      toneFilter: "all",
      brandFilter: "all",
      finishFilter: "holographic",
      availabilityFilter: "all",
    });
    assert.deepEqual(result.map((p) => p.id), ["a", "b"]);
  });
});
