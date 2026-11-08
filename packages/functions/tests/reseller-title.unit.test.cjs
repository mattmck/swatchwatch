const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseResellerTitle,
  RESELLER_LINE_REGEX,
  RESELLER_SET_REGEX,
} = require("../dist/lib/connectors/reseller-title");

// Titles are real Beyond Polish, Harlow & Co and Hypnotic Polish titles (2026-11-08).
const p = parseResellerTitle;

function partial(actual, expected) {
  assert.ok(actual, "expected a parse result");
  for (const [k, v] of Object.entries(expected)) assert.equal(actual[k], v, k);
}

test("parses line, shade and vendor code", () => {
  partial(p("OPI Nail Lacquer - No Room for the Blues 0.5 oz - #NLB83", "OPI"), {
    shadeName: "No Room for the Blues", productLine: "Nail Lacquer", vendorCode: "NLB83", isSet: false,
  });
  partial(p("OPI Infinite Shine - Pink In Bio - #ISLS001", "OPI"), {
    shadeName: "Pink In Bio", productLine: "Infinite Shine", vendorCode: "ISLS001",
  });
  partial(p("Zoya - Fairleigh .5 oz. - #ZP1210", "Zoya"), {
    shadeName: "Fairleigh", productLine: null, vendorCode: "ZP1210",
  });
  partial(p("Essie Eternal Optimist 0.5 oz - #144", "Essie"), { shadeName: "Eternal Optimist", vendorCode: "144" });
  partial(p("CND - Vinylux Candlelight 0.5 oz - #387", "CND"), {
    shadeName: "Vinylux Candlelight", productLine: null,
  });
  partial(p("KBShimmer - Nail Polish - Mix It Up", "KBShimmer"), { shadeName: "Mix It Up", productLine: "Nail Polish" });
  partial(p("Cirque Colors - Nail Polish - Morningtide 0.37 oz", "Cirque Colors"), { shadeName: "Morningtide" });
  partial(p("Londontown - Lakur Enhanced Colour - Dream State 0.4 oz", "Londontown"), {
    shadeName: "Dream State", productLine: "Lakur Enhanced Colour",
  });
  partial(p("butter LONDON - Pure Colour - Hottie Tottie - 21X Nail Lacquer", "butter LONDON"), {
    shadeName: "Hottie Tottie", productLine: "Pure Colour",
  });
  partial(p("ella+mila - Pirouette - .45oz", "ella+mila"), { shadeName: "Pirouette" });
  partial(p("Sundays - Nail Polish - No. 38", "Sundays"), { shadeName: "No. 38" });
  partial(p("*PRE-ORDER* Cuticula Nail Lacquer - Broken Fairytales", "Cuticula Nail Lacquer"), {
    shadeName: "Broken Fairytales",
  });
  partial(p("Cosmic Polish - Beyond the Infinite (Magnetic)", "Cosmic Polish"), {
    shadeName: "Beyond the Infinite",
  });
  partial(p("Highline", "ILNP"), { shadeName: "Highline", productLine: null, vendorCode: null });
});

test("flags sets", () => {
  assert.equal(p("OPI - Gel & Lacquer Combo - Metallic Rewind", "OPI").isSet, true);
  assert.equal(p("Lacquer Set - Ella+Mila Pretty In Pink", "Ella+Mila").isSet, true);
  assert.equal(p("KBShimmer - Nail Polish - It's Fall Good Collection", "KBShimmer").isSet, true);
  assert.equal(p("Zoya - Sonnet Fall Collection", "Zoya").isSet, true);
});

test("exports the regexes and returns null without a shade", () => {
  assert.ok(RESELLER_LINE_REGEX instanceof RegExp);
  assert.ok(RESELLER_SET_REGEX instanceof RegExp);
  assert.equal(p("", "OPI"), null);
  assert.equal(p("OPI - #NLB83", "OPI"), null);
});
