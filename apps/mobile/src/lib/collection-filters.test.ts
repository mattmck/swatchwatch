import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_COLLECTION_VIEW,
  activeFilterCount,
  clearBarFilters,
  collectionViewKey,
  parseCollectionParams,
  polishFiltersKey,
  setPreset,
  toPolishFilters,
  toggleInList,
} from "./collection-filters";
import { COLOR_FAMILIES } from "swatchwatch-shared";

describe("collection filters", () => {
  it("default view matches the old Collection query", () => {
    assert.deepEqual(toPolishFilters(DEFAULT_COLLECTION_VIEW), {
      status: ["owned"],
      search: undefined,
      sortBy: "createdAt",
      sortOrder: "desc",
    });
  });

  it("maps family, category, untried and sort to API params", () => {
    const f = toPolishFilters(
      { preset: "owned", untried: true, families: ["red", "pink"], categories: ["topper"], sort: "brand" },
      "opi",
    );
    assert.deepEqual(f, {
      status: ["owned"],
      untried: true,
      families: ["red", "pink"],
      categories: ["topper"],
      search: "opi",
      sortBy: "brand",
      sortOrder: "asc",
    });
  });

  it("untried is dropped outside the owned preset", () => {
    const f = toPolishFilters({ ...DEFAULT_COLLECTION_VIEW, preset: "wishlist", untried: true });
    assert.equal(f.untried, undefined);
    assert.equal(setPreset({ ...DEFAULT_COLLECTION_VIEW, untried: true }, "wishlist").untried, false);
  });

  it("filter keys are canonical so cached pages never mix sets", () => {
    const a = polishFiltersKey({ status: ["owned"], families: ["red"], sortBy: "name" });
    const b = polishFiltersKey({ sortBy: "name", families: ["red"], status: ["owned"], search: "", categories: [] });
    assert.equal(a, b);
    assert.notEqual(a, polishFiltersKey({ status: ["owned"], families: ["pink"], sortBy: "name" }));
    assert.notEqual(a, polishFiltersKey({ status: ["owned"], families: ["red"], untried: true, sortBy: "name" }));
  });

  it("parses web-style deep link params", () => {
    const v = parseCollectionParams({ family: "gray,Red,nope", untried: "1", category: "top-coat,topper", sort: "brand" });
    assert.deepEqual(v.families, ["red", "grey"]);
    assert.deepEqual(v.categories, ["topper", "top_coat"]);
    assert.equal(v.untried, true);
    assert.equal(v.preset, "owned");
    assert.equal(v.sort, "brand");
    assert.equal(parseCollectionParams({ status: "wishlist", untried: "1" }).untried, false);
    assert.equal(parseCollectionParams({ status: "wishlist" }).preset, "wishlist");
    assert.equal(parseCollectionParams({ sort: "bogus" }).sort, "recent");
    assert.deepEqual(parseCollectionParams({}), DEFAULT_COLLECTION_VIEW);
  });

  it("counts and clears active filters but keeps the status preset", () => {
    const v = { ...DEFAULT_COLLECTION_VIEW, preset: "wishlist" as const, families: ["red" as const], sort: "name" as const };
    assert.equal(activeFilterCount(v), 2);
    assert.deepEqual(clearBarFilters(v), { ...DEFAULT_COLLECTION_VIEW, preset: "wishlist" });
    assert.notEqual(collectionViewKey(v), collectionViewKey(DEFAULT_COLLECTION_VIEW));
  });

  it("toggleInList keeps canonical order", () => {
    assert.deepEqual(toggleInList(["pink"], "red", COLOR_FAMILIES), ["red", "pink"]);
    assert.deepEqual(toggleInList(["red", "pink"], "red", COLOR_FAMILIES), ["pink"]);
  });
});
