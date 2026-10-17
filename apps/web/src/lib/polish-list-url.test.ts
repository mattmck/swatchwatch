import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_LIST_STATE,
  buildPolishesListQueryString,
  hasActiveFilters,
  normalizeStatuses,
  parsePolishesListState,
  parseStatusesParam,
  sameFilters,
  statusFilterSummary,
  statusPresetFor,
  statusesForPreset,
  toApiFilters,
  toggleStatus,
} from "./polish-list-url";
import { POLISH_STATUS_LABELS } from "./inventory-status";

const qs = (value: string) => new URLSearchParams(value);

describe("normalizeStatuses", () => {
  it("dedupes, lowercases, drops unknown values and sorts canonically", () => {
    assert.deepEqual(normalizeStatuses(["archived", " Owned ", "owned", "bogus", ""]), ["owned", "archived"]);
    assert.deepEqual(normalizeStatuses([]), []);
  });
});

describe("parseStatusesParam", () => {
  it("reads the status list", () => {
    assert.deepEqual(parseStatusesParam(qs("status=destash,owned")), ["owned", "destash"]);
    assert.deepEqual(parseStatusesParam(qs("status=")), []);
  });

  it("maps the legacy availability / avail params", () => {
    assert.deepEqual(parseStatusesParam(qs("availability=wishlist")), ["wishlist"]);
    assert.deepEqual(parseStatusesParam(qs("avail=owned")), ["owned"]);
    assert.deepEqual(parseStatusesParam(qs("availability=all")), []);
  });

  it("maps the legacy scope / all params to owned", () => {
    assert.deepEqual(parseStatusesParam(qs("scope=collection")), ["owned"]);
    assert.deepEqual(parseStatusesParam(qs("all=0")), ["owned"]);
    assert.deepEqual(parseStatusesParam(qs("all=false")), ["owned"]);
    assert.deepEqual(parseStatusesParam(qs("scope=all")), []);
    assert.deepEqual(parseStatusesParam(qs("all=1")), []);
  });

  it("prefers status over the legacy params", () => {
    assert.deepEqual(parseStatusesParam(qs("status=archived&scope=collection&availability=wishlist")), ["archived"]);
  });
});

describe("parsePolishesListState / buildPolishesListQueryString", () => {
  it("defaults for an empty URL and writes nothing back", () => {
    const state = parsePolishesListState(qs(""));
    assert.deepEqual(state, DEFAULT_LIST_STATE);
    assert.equal(buildPolishesListQueryString(state), "");
  });

  it("round-trips every field", () => {
    const query = "q=red&status=owned%2Cdestash&untried=1&tone=warm&finish=shimmer&family=red%2Cpink&sort=status&dir=desc&page=3&pageSize=25";
    const state = parsePolishesListState(qs(query));
    assert.deepEqual(state, {
      search: "red",
      statuses: ["owned", "destash"],
      untried: true,
      toneFilter: "warm",
      finishFilter: "shimmer",
      familyFilter: "red,pink",
      sortKey: "status",
      sortDirection: "desc",
      page: 3,
      pageSize: 25,
    });
    assert.equal(buildPolishesListQueryString(state), query);
  });

  it("canonicalizes legacy links to status (never writes scope/availability)", () => {
    const state = parsePolishesListState(qs("scope=collection&availability=owned&page=2"));
    assert.equal(buildPolishesListQueryString(state), "status=owned&page=2");
  });

  it("falls back on invalid values", () => {
    const state = parsePolishesListState(qs("untried=maybe&tone=hot&sort=rating&page=-4&pageSize=7&finish=all"));
    assert.equal(state.untried, false);
    assert.equal(state.toneFilter, "all");
    assert.equal(state.sortKey, "name");
    assert.equal(state.page, 1);
    assert.equal(state.pageSize, 10);
    assert.equal(state.finishFilter, "all");
  });

  it("accepts untried=true", () => {
    assert.equal(parsePolishesListState(qs("untried=true")).untried, true);
  });
});

describe("status presets", () => {
  it("recognizes the presets", () => {
    assert.equal(statusPresetFor([]), "all");
    assert.equal(statusPresetFor(["owned"]), "collection");
    assert.equal(statusPresetFor(["wishlist"]), "wishlist");
    assert.equal(statusPresetFor(["owned", "destash"]), "custom");
    assert.equal(statusPresetFor(["archived"]), "custom");
  });

  it("maps presets back to statuses", () => {
    assert.deepEqual(statusesForPreset("all", ["owned"]), []);
    assert.deepEqual(statusesForPreset("collection"), ["owned"]);
    assert.deepEqual(statusesForPreset("wishlist"), ["wishlist"]);
    assert.deepEqual(statusesForPreset("custom", ["archived", "owned"]), ["owned", "archived"]);
  });
});

describe("toggleStatus", () => {
  it("adds and removes while keeping canonical order", () => {
    assert.deepEqual(toggleStatus(["archived"], "owned", true), ["owned", "archived"]);
    assert.deepEqual(toggleStatus(["owned", "archived"], "owned", false), ["archived"]);
    assert.deepEqual(toggleStatus(["owned"], "owned", true), ["owned"]);
    assert.deepEqual(toggleStatus([], "wishlist", false), []);
  });
});

describe("hasActiveFilters / sameFilters", () => {
  it("counts status and untried as filters", () => {
    assert.equal(hasActiveFilters(DEFAULT_LIST_STATE), false);
    assert.equal(hasActiveFilters({ ...DEFAULT_LIST_STATE, statuses: ["owned"] }), true);
    assert.equal(hasActiveFilters({ ...DEFAULT_LIST_STATE, untried: true }), true);
    assert.equal(hasActiveFilters({ ...DEFAULT_LIST_STATE, search: "  " }), false);
  });

  it("ignores paging when comparing filters", () => {
    assert.equal(sameFilters(DEFAULT_LIST_STATE, { ...DEFAULT_LIST_STATE, page: 4, pageSize: 50 }), true);
    assert.equal(sameFilters(DEFAULT_LIST_STATE, { ...DEFAULT_LIST_STATE, statuses: ["owned"] }), false);
    assert.equal(sameFilters(DEFAULT_LIST_STATE, { ...DEFAULT_LIST_STATE, untried: true }), false);
  });
});

describe("toApiFilters", () => {
  it("sends only status/untried for ownership (no scope/availability)", () => {
    const filters = toApiFilters({
      ...DEFAULT_LIST_STATE,
      search: "  ruby ",
      statuses: ["destash", "owned"],
      untried: true,
      finishFilter: "creme",
      sortKey: "brand",
      sortDirection: "desc",
    });
    assert.deepEqual(filters, {
      search: "ruby",
      finish: "creme",
      status: ["owned", "destash"],
      untried: true,
      sortBy: "brand",
      sortOrder: "desc",
    });
    assert.equal("scope" in filters, false);
    assert.equal("availability" in filters, false);
  });

  it("omits empty filters", () => {
    const filters = toApiFilters(DEFAULT_LIST_STATE);
    assert.equal(filters.status, undefined);
    assert.equal(filters.untried, undefined);
    assert.equal(filters.search, undefined);
    assert.equal(filters.finish, undefined);
    assert.equal("families" in filters, false);
  });

  it("sends the color family filter (#103) as families", () => {
    const state = { ...DEFAULT_LIST_STATE, familyFilter: "pink,red" };
    assert.deepEqual(toApiFilters(state).families, ["red", "pink"]);
    assert.equal(hasActiveFilters(state), true);
  });
});

describe("statusFilterSummary", () => {
  it("summarizes the selection for the trigger label", () => {
    assert.equal(statusFilterSummary([], POLISH_STATUS_LABELS), "Any status");
    assert.equal(statusFilterSummary(["destash"], POLISH_STATUS_LABELS), "Destash");
    assert.equal(statusFilterSummary(["owned", "destash", "archived"], POLISH_STATUS_LABELS), "Owned +2");
  });
});
