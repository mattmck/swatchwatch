import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PolishStatus } from "swatchwatch-shared";
import {
  CATALOG_SEARCH_HREF,
  GETTING_STARTED_STEPS,
  polishesEmptyStateKind,
  shouldFocusSearch,
} from "./onboarding";

describe("web step routes", () => {
  it("maps the three ways in to web routes", () => {
    assert.deepEqual(
      GETTING_STARTED_STEPS.map((step) => [step.id, step.href]),
      [
        ["import", "/polishes/import"],
        ["scan", "/rapid-add"],
        ["search", CATALOG_SEARCH_HREF],
      ]
    );
  });

  it("links catalog search to every polish with the search box focused", () => {
    const params = new URLSearchParams(CATALOG_SEARCH_HREF.split("?")[1]);
    assert.equal(new URL(CATALOG_SEARCH_HREF, "https://x").pathname, "/polishes");
    assert.equal(shouldFocusSearch(params), true);
  });
});

describe("shouldFocusSearch", () => {
  it("is true only for focus=search", () => {
    assert.equal(shouldFocusSearch(new URLSearchParams("focus=search")), true);
    assert.equal(shouldFocusSearch(new URLSearchParams("focus=other")), false);
    assert.equal(shouldFocusSearch(new URLSearchParams("")), false);
  });
});

describe("polishesEmptyStateKind", () => {
  const base: Parameters<typeof polishesEmptyStateKind>[0] = {
    search: "",
    statuses: [] as PolishStatus[],
    untried: false,
    toneFilter: "all",
    finishFilter: "all",
    familyFilter: "",
  };

  it("explains an empty collection when My Collection has no rows", () => {
    assert.equal(polishesEmptyStateKind({ ...base, statuses: ["owned"] }), "collection");
  });

  it("explains an empty wishlist", () => {
    assert.equal(polishesEmptyStateKind({ ...base, statuses: ["wishlist"] }), "wishlist");
  });

  it("covers other status combinations such as destash + archived", () => {
    assert.equal(polishesEmptyStateKind({ ...base, statuses: ["destash", "archived"] }), "status");
  });

  it("says the filters matched nothing once any non-status filter is on", () => {
    assert.equal(polishesEmptyStateKind({ ...base, statuses: ["owned"], search: "holo" }), "filtered");
    assert.equal(polishesEmptyStateKind({ ...base, statuses: ["owned"], untried: true }), "filtered");
    assert.equal(polishesEmptyStateKind({ ...base, toneFilter: "warm" }), "filtered");
    assert.equal(polishesEmptyStateKind({ ...base, finishFilter: "holo" }), "filtered");
    assert.equal(polishesEmptyStateKind({ ...base, familyFilter: "red" }), "filtered");
  });

  it("ignores a whitespace-only search", () => {
    assert.equal(polishesEmptyStateKind({ ...base, statuses: ["owned"], search: "  " }), "collection");
  });

  it("falls back to an empty catalog when nothing is filtered", () => {
    assert.equal(polishesEmptyStateKind(base), "catalog");
  });
});
