import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CollectionGapCell } from "swatchwatch-shared";
import {
  cellKey,
  getCellClasses,
  getGapSearchHref,
  getHealthyCellStyle,
  getRowCellPresentation,
  getSeverity,
  getVisibleItems,
  shouldShowTruncationSummary,
  sortCellsByGridOrder,
} from "../app/(app)/polishes/gaps/gaps-utils";

function cell(overrides: Partial<CollectionGapCell>): CollectionGapCell {
  return {
    hueFamily: "reds",
    lightnessBand: "medium",
    count: 0,
    ...overrides,
  };
}

describe("cellKey", () => {
  it("builds hue/lightness key", () => {
    assert.equal(cellKey(cell({ hueFamily: "blues-teals", lightnessBand: "light" })), "blues-teals:light");
  });
});

describe("sortCellsByGridOrder", () => {
  it("sorts by lightness first, then hue order, without mutating input", () => {
    const input = [
      cell({ hueFamily: "greens", lightnessBand: "light" }),
      cell({ hueFamily: "reds", lightnessBand: "dark" }),
      cell({ hueFamily: "blues-teals", lightnessBand: "dark" }),
    ];
    const snapshot = [...input];

    const sorted = sortCellsByGridOrder(input);

    assert.deepEqual(
      sorted.map((item) => `${item.hueFamily}:${item.lightnessBand}`),
      ["reds:dark", "blues-teals:dark", "greens:light"],
    );
    assert.deepEqual(input, snapshot);
  });
});

describe("getSeverity", () => {
  it("returns missing first, then thin, then healthy", () => {
    const target = cell({ hueFamily: "reds", lightnessBand: "dark" });
    const key = cellKey(target);

    assert.equal(getSeverity(target, new Set([key]), new Set([key])), "missing");
    assert.equal(getSeverity(target, new Set(), new Set([key])), "thin");
    assert.equal(getSeverity(target, new Set(), new Set()), "healthy");
  });
});

describe("getCellClasses", () => {
  it("returns severity classes and selected ring when selected", () => {
    assert.match(getCellClasses("missing", true), /border-rose-400\/65/);
    assert.match(getCellClasses("thin", false), /border-amber-400\/65/);
    assert.match(getCellClasses("healthy", true), /ring-2 ring-brand-purple\/70/);
  });
});

describe("getHealthyCellStyle", () => {
  it("computes deterministic healthy style and handles maxCount=0 edge case", () => {
    assert.deepEqual(getHealthyCellStyle(cell({ hueFamily: "neutrals", count: 3 }), 10), {
      backgroundColor: "hsl(220 8% 53.6%)",
    });
    assert.deepEqual(getHealthyCellStyle(cell({ hueFamily: "reds", count: 5 }), 0), {
      backgroundColor: "hsl(8 76% 56%)",
    });
  });
});

describe("getGapSearchHref", () => {
  it("builds search URL with similar harmony and seed hex without #", () => {
    const href = getGapSearchHref(cell({ hueFamily: "greens", lightnessBand: "dark-medium" }));
    assert.match(href, /^\/polishes\/search\?/);
    const query = new URLSearchParams(href.split("?")[1]);
    assert.equal(query.get("harmony"), "similar");
    assert.match(query.get("color") ?? "", /^[0-9A-F]{6}$/i);
  });
});

describe("component helper extraction", () => {
  it("supports compact list helpers", () => {
    assert.deepEqual(getVisibleItems([1, 2, 3], 2), [1, 2]);
    assert.deepEqual(getVisibleItems([1, 2, 3], 0), []);
    assert.equal(shouldShowTruncationSummary(5, 2), true);
    assert.equal(shouldShowTruncationSummary(2, 2), false);
  });

  it("builds row presentation data with severity class and title", () => {
    const target = cell({ hueFamily: "reds", lightnessBand: "dark", count: 2 });
    const cellsByKey = new Map([[cellKey(target), target]]);
    const presentation = getRowCellPresentation({
      hueFamily: "reds",
      lightnessBand: "dark",
      cellsByKey,
      maxCellCount: 4,
      missingKeys: new Set<string>(),
      thinKeys: new Set<string>([cellKey(target)]),
      selectedCellKey: cellKey(target),
    });

    assert.ok(presentation);
    assert.equal(presentation?.key, "reds:dark");
    assert.equal(presentation?.severity, "thin");
    assert.match(presentation?.className ?? "", /ring-2 ring-brand-purple\/70/);
    assert.match(presentation?.title ?? "", /Reds/);
    assert.equal(
      getRowCellPresentation({
        hueFamily: "reds",
        lightnessBand: "light",
        cellsByKey,
        maxCellCount: 4,
        missingKeys: new Set<string>(),
        thinKeys: new Set<string>(),
        selectedCellKey: null,
      }),
      null,
    );
  });
});
