import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { COLOR_FAMILIES } from "swatchwatch-shared";
import {
  colorFamilySwatchBackground,
  parseColorFamilyParam,
  serializeColorFamilies,
  toggleColorFamily,
} from "./color-family-filter";

describe("parseColorFamilyParam", () => {
  it("returns [] for a missing or empty value", () => {
    assert.deepEqual(parseColorFamilyParam(null), []);
    assert.deepEqual(parseColorFamilyParam(undefined), []);
    assert.deepEqual(parseColorFamilyParam(""), []);
    assert.deepEqual(parseColorFamilyParam(" , "), []);
  });

  it("normalizes case, whitespace, duplicates and order; reads gray as grey", () => {
    assert.deepEqual(parseColorFamilyParam(" Pink,red,RED, gray "), ["red", "pink", "grey"]);
  });

  it("drops unknown families instead of failing", () => {
    assert.deepEqual(parseColorFamilyParam("mauve,teal,<script>"), ["teal"]);
  });
});

describe("serializeColorFamilies", () => {
  it("joins in canonical order, or returns an empty string", () => {
    assert.equal(serializeColorFamilies([]), "");
    assert.equal(serializeColorFamilies(["white", "black", "multichrome"]), "black,white,multichrome");
  });
});

describe("toggleColorFamily", () => {
  it("adds and removes a family, keeping canonical order", () => {
    const added = toggleColorFamily(["blue"], "red");
    assert.deepEqual(added, ["red", "blue"]);
    assert.deepEqual(toggleColorFamily(added, "blue"), ["red"]);
    assert.deepEqual(toggleColorFamily(["red"], "red"), []);
  });

  it("round-trips every family through the URL format", () => {
    const all = COLOR_FAMILIES.reduce<(typeof COLOR_FAMILIES)[number][]>(
      (acc, family) => toggleColorFamily(acc, family),
      []
    );
    assert.deepEqual(parseColorFamilyParam(serializeColorFamilies(all)), [...COLOR_FAMILIES]);
  });
});

describe("colorFamilySwatchBackground", () => {
  it("uses the swatch hex, except a gradient for multichrome", () => {
    assert.equal(colorFamilySwatchBackground("red", "#C8102E"), "#C8102E");
    assert.match(colorFamilySwatchBackground("multichrome", "#6A5ACD"), /^conic-gradient\(/);
  });
});
