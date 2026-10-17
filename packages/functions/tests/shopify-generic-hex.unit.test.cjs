const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  extractHexFromOption,
  extractHexFromProduct,
} = require("../dist/lib/connectors/shopify-generic");

describe("lib/connectors/shopify-generic — hex extraction", () => {
  describe("shade names made of hex letters are not colors", () => {
    // Real titles seen on live storefronts that the old /#?([0-9A-F]{6})/ regex
    // turned into fake vendor hexes.
    const titles = [
      "Facade", // Sassysauce → #FACADE
      "Chewiebacca", // Red Eyed → #EBACCA
      "Untouchable Decadence", // Orly → #DECADE
      "Decade of Dam", // Dam → #DECADE
    ];

    for (const title of titles) {
      it(`returns null for option value "${title}"`, () => {
        assert.equal(extractHexFromOption(title), null);
      });

      it(`returns null for product titled "${title}"`, () => {
        assert.equal(
          extractHexFromProduct({ title, variants: [{ option1: title }] }),
          null
        );
      });
    }

    it("ignores a bare six-digit hex without '#'", () => {
      assert.equal(extractHexFromOption("A1B2C3"), null);
    });

    it("ignores '#' followed by more than six hex characters", () => {
      assert.equal(extractHexFromOption("#A1B2C3D4"), null);
    });
  });

  describe("real hex values still match", () => {
    it("extracts '#A1B2C3' from an option value", () => {
      assert.equal(extractHexFromOption("#A1B2C3"), "#A1B2C3");
    });

    it("uppercases a lowercase hex embedded in an option value", () => {
      assert.equal(extractHexFromOption("Berry Red / #a1b2c3"), "#A1B2C3");
    });

    it("extracts the hex from a variant option before the title", () => {
      assert.equal(
        extractHexFromProduct({
          title: "Facade",
          variants: [{ option1: "Default Title" }, { option2: "#A1B2C3" }],
        }),
        "#A1B2C3"
      );
    });
  });

  it("returns null for empty input", () => {
    assert.equal(extractHexFromOption(null), null);
    assert.equal(extractHexFromOption(""), null);
  });
});
