import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyHexColorFamily, hexToOklch, type Polish } from "swatchwatch-shared";
import {
  CATALOG_FETCH_SIZE,
  catalogColorQuery,
  COLLECTION_FALLBACK_MIN,
  COLOR_RESULT_LIMIT,
  gradeLabel,
  HUE_STOPS,
  LIGHTNESS_STEPS,
  normalizeHexParam,
  pickerHex,
  rankByColor,
  toggleFamily,
} from "./color-search";

function polish(id: string, extra: Partial<Polish> = {}): Polish {
  return { id, shadeId: id, userId: "1", brand: "B", name: `P${id}`, status: "owned", createdAt: "", updatedAt: "", ...extra } as Polish;
}

describe("pickerHex", () => {
  it("gives a valid hex for every stop, with increasing lightness", () => {
    for (const hue of [...HUE_STOPS, null]) {
      let last = -1;
      for (let i = 0; i < LIGHTNESS_STEPS.length; i++) {
        const hex = pickerHex(hue, i);
        assert.match(hex, /^#[0-9A-F]{6}$/);
        const { L } = hexToOklch(hex);
        assert.ok(L > last, `${hue}/${i}`);
        last = L;
      }
    }
  });

  it("maps hue stops to the expected families", () => {
    assert.equal(classifyHexColorFamily(pickerHex(30, 1)), "red");
    assert.equal(classifyHexColorFamily(pickerHex(240, 1)), "blue");
    assert.ok(hexToOklch(pickerHex(null, 2)).C < 0.03, "neutral stop is near gray");
  });
});

describe("normalizeHexParam", () => {
  it("accepts with or without #, any case, and the first array entry", () => {
    assert.equal(normalizeHexParam("c0392b"), "#C0392B");
    assert.equal(normalizeHexParam("#C0392B"), "#C0392B");
    assert.equal(normalizeHexParam(["1f4e9c", "x"]), "#1F4E9C");
  });
  it("rejects anything else", () => {
    for (const bad of [undefined, null, "", "red", "#FFF", "GGGGGG"]) assert.equal(normalizeHexParam(bad), null);
  });
});

describe("rankByColor", () => {
  const rows = [
    polish("far", { vendorHex: "#1F4E9C" }),
    polish("close", { vendorHex: "#C23A2D" }),
    polish("medium", { vendorHex: "#D85A40" }),
    polish("topper", { vendorHex: "#C0392B", productCategory: "topper" }),
    polish("nohex"),
    polish("close", { vendorHex: "#C23A2D" }),
  ];

  it("ranks color polishes by OKLAB distance with dupe-rule grades", () => {
    const ranked = rankByColor(rows, "#C0392B");
    assert.deepEqual(ranked.map((m) => m.polish.id), ["close", "medium", "far"]);
    assert.deepEqual(ranked.map((m) => m.grade), ["high", "medium", "low"]);
    assert.ok(ranked[0].distance < ranked[1].distance);
  });

  it("respects the limit", () => {
    assert.equal(rankByColor(rows, "#C0392B", 1).length, 1);
  });

  it("ranks estimated name-only hexes after measured ones and never grades them above low", () => {
    const ranked = rankByColor(
      [
        polish("guess", { nameHex: "#C0392B" }),
        polish("measured-far", { detectedHex: "#1F4E9C", nameHex: "#C0392B" }),
        polish("measured", { vendorHex: "#D85A40" }),
      ],
      "#C0392B",
    );
    assert.deepEqual(ranked.map((m) => m.polish.id), ["measured", "measured-far", "guess"]);
    assert.deepEqual(ranked.map((m) => m.estimated), [false, false, true]);
    assert.equal(ranked[2].distance, 0);
    assert.equal(ranked[2].grade, "low");
  });

  it("labels only HIGH and MEDIUM", () => {
    assert.equal(gradeLabel("high"), "HIGH");
    assert.equal(gradeLabel("medium"), "MEDIUM");
    assert.equal(gradeLabel("low"), null);
  });
});

describe("families", () => {
  it("ranks the whole catalog on the server, narrowed only by the selected chips", () => {
    assert.deepEqual(catalogColorQuery("#C0392B", ["pink"]), {
      families: ["pink"],
      nearHex: ["#C0392B"],
      pageSize: CATALOG_FETCH_SIZE,
    });
    // No chips: no family filter (the server ranks every color polish, not a family sample).
    assert.deepEqual(catalogColorQuery("#C0392B", []).families, []);
  });
  it("fetches enough rows for the shown results after dropping owned ones in the fallback", () => {
    assert.equal(CATALOG_FETCH_SIZE, COLOR_RESULT_LIMIT + COLLECTION_FALLBACK_MIN);
  });
  it("toggles chips", () => {
    assert.deepEqual(toggleFamily(["red"], "pink"), ["red", "pink"]);
    assert.deepEqual(toggleFamily(["red", "pink"], "red"), ["pink"]);
  });
});
