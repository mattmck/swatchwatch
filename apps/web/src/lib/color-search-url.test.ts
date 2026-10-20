import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_COLOR_SEARCH_STATE,
  buildColorSearchQueryString,
  colorSearchHref,
  parseColorSearchState,
  type ColorSearchUrlState,
} from "./color-search-url";

const qs = (value: string) => new URLSearchParams(value);

describe("parseColorSearchState (#348)", () => {
  it("returns the defaults for an empty query", () => {
    assert.deepEqual(parseColorSearchState(qs("")), DEFAULT_COLOR_SEARCH_STATE);
  });

  it("reads every field", () => {
    const state = parseColorSearchState(
      qs(
        "color=ff8800&harmony=triadic&wheel=snap&set=collection&scope=collection&tone=warm" +
          "&brand=Holo%20Taco&finish=holo&avail=wishlist&focus=aa0000,00bb00&target=00bb00" +
          "&palette=triadic-%23FF8800-%23001122"
      )
    );
    assert.deepEqual(state, {
      color: "#FF8800",
      harmony: "triadic",
      wheelMode: "snap",
      harmonyColorSet: "collection",
      resultsScope: "collection",
      toneFilter: "warm",
      brandFilter: "Holo Taco",
      finishFilter: "holo",
      availabilityFilter: "wishlist",
      paletteAnchors: ["#AA0000", "#00BB00"],
      target: "#00BB00",
      paletteId: "triadic-#FF8800-#001122",
    } satisfies ColorSearchUrlState);
  });

  it("accepts a color with a leading #, and the gap map's similar harmony", () => {
    const state = parseColorSearchState(qs("color=%23a1b2c3&harmony=similar"));
    assert.equal(state.color, "#A1B2C3");
    assert.equal(state.harmony, "similar");
  });

  it("drops invalid values", () => {
    const state = parseColorSearchState(
      qs("color=red&harmony=bogus&wheel=x&set=y&scope=z&tone=hot&avail=maybe&focus=xyz,123456,123456&target=nope")
    );
    assert.deepEqual(state, { ...DEFAULT_COLOR_SEARCH_STATE, paletteAnchors: ["#123456"] });
  });

  it("keeps at most 8 anchors (the newest)", () => {
    const hexes = Array.from({ length: 10 }, (_, i) => `00000${i}`);
    const state = parseColorSearchState(qs(`focus=${hexes.join(",")}`));
    assert.equal(state.paletteAnchors.length, 8);
    assert.equal(state.paletteAnchors[0], "#000002");
    assert.equal(state.paletteAnchors[7], "#000009");
  });
});

describe("buildColorSearchQueryString", () => {
  it("omits defaults", () => {
    assert.equal(buildColorSearchQueryString(DEFAULT_COLOR_SEARCH_STATE), "");
  });

  it("round-trips through parse", () => {
    const state: ColorSearchUrlState = {
      color: "#FF8800",
      harmony: "complementary",
      wheelMode: "snap",
      harmonyColorSet: "all",
      resultsScope: "collection",
      toneFilter: "cool",
      brandFilter: "Cirque & Co",
      finishFilter: "creme",
      availabilityFilter: "owned",
      paletteAnchors: ["#AA0000", "#00BB00"],
      target: "#AA0000",
      paletteId: "complementary-#FF8800-#0077FF",
    };
    const query = buildColorSearchQueryString(state);
    assert.deepEqual(parseColorSearchState(qs(query)), state);
    // Canonical: building again from the parsed state gives the same string.
    assert.equal(buildColorSearchQueryString(parseColorSearchState(qs(query))), query);
  });

  it("writes the color without # in upper case", () => {
    const query = buildColorSearchQueryString({ ...DEFAULT_COLOR_SEARCH_STATE, color: "#ab12cd" });
    assert.equal(query, "color=AB12CD");
  });
});

describe("colorSearchHref", () => {
  it("builds the page URL", () => {
    assert.equal(colorSearchHref(DEFAULT_COLOR_SEARCH_STATE), "/polishes/search");
    assert.equal(
      colorSearchHref({ ...DEFAULT_COLOR_SEARCH_STATE, color: "#112233", resultsScope: "collection" }),
      "/polishes/search?color=112233&scope=collection"
    );
  });
});
