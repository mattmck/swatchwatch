const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { isSuspiciousHex } = require("../dist/lib/suspicious-hex");

describe("lib/suspicious-hex — isSuspiciousHex", () => {
  describe("null/undefined/empty values", () => {
    it("returns true for null", () => {
      assert.equal(isSuspiciousHex(null), true);
    });

    it("returns true for undefined", () => {
      assert.equal(isSuspiciousHex(undefined), true);
    });

    it("returns true for empty string", () => {
      assert.equal(isSuspiciousHex(""), true);
    });

    it("returns true for whitespace-only string", () => {
      assert.equal(isSuspiciousHex("   "), true);
    });
  });

  describe("pure black/white", () => {
    it("returns true for #000000", () => {
      assert.equal(isSuspiciousHex("#000000"), true);
    });

    it("returns true for #FFFFFF", () => {
      assert.equal(isSuspiciousHex("#FFFFFF"), true);
    });

    it("returns true for lowercase #ffffff", () => {
      assert.equal(isSuspiciousHex("#ffffff"), true);
    });

    it("returns true for mixed case #FfFfFf", () => {
      assert.equal(isSuspiciousHex("#FfFfFf"), true);
    });
  });

  describe("gray placeholder values", () => {
    it("returns true for #808080", () => {
      assert.equal(isSuspiciousHex("#808080"), true);
    });

    it("returns true for #C0C0C0", () => {
      assert.equal(isSuspiciousHex("#C0C0C0"), true);
    });

    it("returns true for #DCDCDC", () => {
      assert.equal(isSuspiciousHex("#DCDCDC"), true);
    });

    it("returns true for gray scale steps (#111111 through #EEEEEE)", () => {
      const graySteps = [
        "#111111", "#222222", "#333333", "#444444", "#555555",
        "#666666", "#777777", "#888888", "#999999", "#AAAAAA",
        "#BBBBBB", "#CCCCCC", "#DDDDDD", "#EEEEEE", "#F0F0F0",
      ];
      for (const hex of graySteps) {
        assert.equal(isSuspiciousHex(hex), true, `expected ${hex} to be suspicious`);
      }
    });
  });

  describe("pure primary/secondary colors", () => {
    it("returns true for pure red #FF0000", () => {
      assert.equal(isSuspiciousHex("#FF0000"), true);
    });

    it("returns true for pure green #00FF00", () => {
      assert.equal(isSuspiciousHex("#00FF00"), true);
    });

    it("returns true for pure blue #0000FF", () => {
      assert.equal(isSuspiciousHex("#0000FF"), true);
    });

    it("returns true for pure yellow #FFFF00", () => {
      assert.equal(isSuspiciousHex("#FFFF00"), true);
    });

    it("returns true for pure magenta #FF00FF", () => {
      assert.equal(isSuspiciousHex("#FF00FF"), true);
    });

    it("returns true for pure cyan #00FFFF", () => {
      assert.equal(isSuspiciousHex("#00FFFF"), true);
    });
  });

  describe("legitimate polish colors", () => {
    it("returns false for a realistic red #E64B4B", () => {
      assert.equal(isSuspiciousHex("#E64B4B"), false);
    });

    it("returns false for a realistic pink #F5A5B8", () => {
      assert.equal(isSuspiciousHex("#F5A5B8"), false);
    });

    it("returns false for a realistic blue #4169E1", () => {
      assert.equal(isSuspiciousHex("#4169E1"), false);
    });

    it("returns false for a realistic coral #FF7F50", () => {
      assert.equal(isSuspiciousHex("#FF7F50"), false);
    });

    it("returns false for a realistic nude #D4A574", () => {
      assert.equal(isSuspiciousHex("#D4A574"), false);
    });

    it("returns false for a near-black color #1A1A2E", () => {
      assert.equal(isSuspiciousHex("#1A1A2E"), false);
    });

    it("returns false for an off-white color #FFFAF0", () => {
      assert.equal(isSuspiciousHex("#FFFAF0"), false);
    });
  });

  describe("values without hash prefix", () => {
    it("returns true for 000000 (without #)", () => {
      assert.equal(isSuspiciousHex("000000"), true);
    });

    it("returns true for FFFFFF (without #)", () => {
      assert.equal(isSuspiciousHex("FFFFFF"), true);
    });

    it("returns false for E64B4B (without #)", () => {
      assert.equal(isSuspiciousHex("E64B4B"), false);
    });
  });

  describe("whitespace handling", () => {
    it("trims leading/trailing whitespace before checking", () => {
      assert.equal(isSuspiciousHex("  #000000  "), true);
    });

    it("handles whitespace around legitimate colors", () => {
      assert.equal(isSuspiciousHex("  #E64B4B  "), false);
    });
  });
});
