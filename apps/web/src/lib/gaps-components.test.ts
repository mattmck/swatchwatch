import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { LightnessBand, Polish } from "swatchwatch-shared";
import {
  CellMatchesList,
  Row,
  type CellBoundPolish,
} from "../app/(app)/polishes/gaps/gaps-components";

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

function boundPolish(id: string): CellBoundPolish {
  return {
    polish: polish({ id, brand: `Brand-${id}`, name: `Shade-${id}` }),
    colorHex: "#AA11CC",
    hueFamily: "reds",
    lightnessBand: "medium",
    owned: true,
  };
}

describe("CellMatchesList", () => {
  it("delegates visible item selection to injected helper", () => {
    const items = [boundPolish("1"), boundPolish("2")];
    let calls = 0;

    const html = renderToStaticMarkup(
      createElement(CellMatchesList, {
        title: "Test",
        items,
        emptyLabel: "None",
        resolveVisibleItems: (input: CellBoundPolish[], maxVisible = 6) => {
          calls += 1;
          assert.equal(maxVisible, 6);
          assert.equal(input.length, 2);
          return [];
        },
      }),
    );

    assert.equal(calls, 1);
    assert.equal((html.match(/\/polishes\/detail\?id=/g) ?? []).length, 0);
    assert.match(html, /None/);
  });
});

describe("Row", () => {
  it("delegates per-cell derivation to injected resolver", () => {
    let calls = 0;
    const selected: string[] = [];

    const html = renderToStaticMarkup(
      createElement(Row, {
        lightnessBand: "dark" as LightnessBand,
        cellsByKey: new Map(),
        maxCellCount: 0,
        missingKeys: new Set<string>(),
        thinKeys: new Set<string>(),
        selectedCellKey: null,
        onSelect: (key: string) => selected.push(key),
        resolveCellPresentation: ({ hueFamily, lightnessBand }) => {
          calls += 1;
          if (hueFamily !== "reds") return null;
          return {
            key: `${hueFamily}:${lightnessBand}`,
            title: "Reds • Dark: 0",
            severity: "missing",
            className: "row-test-class",
            style: undefined,
            count: 0,
            lightnessShort: "D",
            severityLabel: "Missing",
          };
        },
      }),
    );

    assert.equal(calls, 8);
    assert.match(html, /row-test-class/);
    assert.match(html, /Missing/);
    assert.equal(selected.length, 0);
  });
});
