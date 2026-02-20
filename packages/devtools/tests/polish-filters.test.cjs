const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const FILTERS_PATH = path.resolve(
  __dirname,
  "../../../apps/web/src/lib/polish-filters.ts"
);

async function importFilters() {
  return import(FILTERS_PATH);
}

function createPolish(overrides = {}) {
  return {
    id: `id-${Math.random().toString(16).slice(2)}`,
    shadeId: "shade-1",
    userId: "1",
    brand: "Brand",
    name: "Name",
    color: "Color",
    createdAt: "2026-02-01T00:00:00.000Z",
    updatedAt: "2026-02-01T00:00:00.000Z",
    ...overrides,
  };
}

test("polish-filters: buildBrandOptions deduplicates case-insensitively and preserves first casing", async () => {
  const { buildBrandOptions } = await importFilters();
  const polishes = [
    createPolish({ brand: "  ILNP  " }),
    createPolish({ brand: "ilnp" }),
    createPolish({ brand: "Mooncat" }),
    createPolish({ brand: " mooncat " }),
  ];

  const options = buildBrandOptions(polishes);
  assert.deepEqual(options, ["ILNP", "Mooncat"]);
});

test("polish-filters: filterPolishesForList matches brand case-insensitively and trims whitespace", async () => {
  const { filterPolishesForList } = await importFilters();
  const polishes = [
    createPolish({ id: "a", brand: "  ILNP  ", quantity: 1 }),
    createPolish({ id: "b", brand: "ilnp", quantity: 0 }),
    createPolish({ id: "c", brand: "Mooncat", quantity: 1 }),
  ];

  const filtered = filterPolishesForList({
    polishes,
    search: "",
    includeAll: true,
    toneFilter: "all",
    brandFilter: " iLnP ",
    finishFilter: "all",
    availabilityFilter: "all",
  });

  assert.deepEqual(
    filtered.map((p) => p.id).sort(),
    ["a", "b"]
  );
});

test("polish-filters: brand filter composes correctly with owned state and tone via resolveDisplayHex", async () => {
  const { filterPolishesForList } = await importFilters();
  const polishes = [
    createPolish({
      id: "owned-warm",
      brand: "ILNP",
      quantity: 1,
      vendorHex: "#FF0000",
    }),
    createPolish({
      id: "wishlist-cool",
      brand: "ilnp ",
      quantity: 0,
      detectedHex: "#0000FF",
    }),
    createPolish({
      id: "vendor-priority",
      brand: "ILNP",
      quantity: 0,
      vendorHex: "#FF0000",
      detectedHex: "#0000FF",
    }),
  ];

  const coolInBrand = filterPolishesForList({
    polishes,
    search: "",
    includeAll: true,
    toneFilter: "cool",
    brandFilter: "ilnp",
    finishFilter: "all",
    availabilityFilter: "all",
  });
  assert.deepEqual(coolInBrand.map((p) => p.id), ["wishlist-cool"]);

  const coolOwnedOnly = filterPolishesForList({
    polishes,
    search: "",
    includeAll: false,
    toneFilter: "cool",
    brandFilter: "ilnp",
    finishFilter: "all",
    availabilityFilter: "all",
  });
  assert.equal(coolOwnedOnly.length, 0);

  const coolWishlistOnly = filterPolishesForList({
    polishes,
    search: "",
    includeAll: true,
    toneFilter: "cool",
    brandFilter: "ilnp",
    finishFilter: "all",
    availabilityFilter: "wishlist",
  });
  assert.deepEqual(coolWishlistOnly.map((p) => p.id), ["wishlist-cool"]);
});
