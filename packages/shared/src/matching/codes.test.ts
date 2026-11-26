import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildVendorCodeIndex, findPrintedGtins, findVendorCodeShades, isVendorCodeAlias } from "./codes";
import { hasValidGtinCheckDigit } from "../barcode/gtin";

describe("isVendorCodeAlias", () => {
  it("needs no space, a digit and 4+ characters", () => {
    assert.equal(isVendorCodeAlias("NLF008"), true);
    assert.equal(isVendorCodeAlias("2000344"), true);
    assert.equal(isVendorCodeAlias("NLF-008"), true);
    assert.equal(isVendorCodeAlias("NL8"), false);
    assert.equal(isVendorCodeAlias("Matte Top Coat"), false);
    assert.equal(isVendorCodeAlias("Winter"), false);
    assert.equal(isVendorCodeAlias("NLF 008"), false);
  });
});

describe("vendor code lookup", () => {
  const index = buildVendorCodeIndex([
    { shadeId: 1, aliases: ["NLF008", "Some Listing Title"] },
    { shadeId: 2, aliases: ["2000344"] },
    { shadeId: 3 },
  ]);
  it("matches a token after normalisation", () => {
    assert.deepEqual(findVendorCodeShades(["nlf-008"], index), [1]);
    assert.deepEqual(findVendorCodeShades(["x", "2000344"], index), [2]);
    assert.deepEqual(findVendorCodeShades(["NLF", "008"], index), []);
    assert.deepEqual(findVendorCodeShades(["Some Listing Title"], index), []);
  });
});

describe("findPrintedGtins", () => {
  it("accepts 12 and 13 digit codes with a valid check digit", () => {
    assert.deepEqual(findPrintedGtins(["4006381333931"]), ["4006381333931"]);
    assert.deepEqual(findPrintedGtins(["0 36000 29145 2"]), ["036000291452"]);
    assert.deepEqual(findPrintedGtins(["036000291452", "036000291452"]), ["036000291452"]);
  });
  it("rejects a wrong check digit, other lengths and non-codes", () => {
    assert.deepEqual(findPrintedGtins(["4006381333932"]), []);
    assert.deepEqual(findPrintedGtins(["036000291453"]), []);
    assert.deepEqual(findPrintedGtins(["40063813", "12345678901234", "polish"]), []);
  });
  it("agrees with the shared check digit for every 12 and 13 digit string", () => {
    // Reference: the prototype's gtin_ok (mod-10, weights 3,1 from the digit next to the check digit).
    const ref = (d: string) => {
      const digits = [...d].map(Number);
      const body = digits.slice(0, -1);
      let total = 0;
      [...body].reverse().forEach((v, i) => { total += v * (i % 2 === 0 ? 3 : 1); });
      return (10 - (total % 10)) % 10 === digits[digits.length - 1];
    };
    let seed = 12345;
    const next = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
    for (let i = 0; i < 2000; i += 1) {
      const len = i % 2 === 0 ? 12 : 13;
      let s = "";
      for (let k = 0; k < len; k += 1) s += String(next() % 10);
      assert.equal(hasValidGtinCheckDigit(s), ref(s), s);
    }
  });
});
