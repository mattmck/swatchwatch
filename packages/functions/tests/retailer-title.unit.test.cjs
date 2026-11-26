const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseBrandStoreTitle,
  parseConnectorTitle,
  parseRetailerTitle,
  RETAILER_LINE_REGEX,
  RETAILER_SET_REGEX,
} = require("../dist/lib/connectors/retailer-title");

// Titles are real Beyond Polish, Harlow & Co and Hypnotic Polish titles (2026-11-08).
const p = parseRetailerTitle;

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
  assert.deepEqual(
    [p("Set Sail", "ILNP"), p("ILNP - Set Sail", "ILNP")].map((r) => [r.shadeName, r.isSet]),
    [["Set Sail", false], ["Set Sail", false]]
  );
});

test("exports the regexes and returns null without a shade", () => {
  assert.ok(RETAILER_LINE_REGEX instanceof RegExp);
  assert.ok(RETAILER_SET_REGEX instanceof RegExp);
  assert.equal(p("", "OPI"), null);
  assert.equal(p("OPI - #NLB83", "OPI"), null);
});

test("an all-line title keeps its last segment as the shade", () => {
  partial(p("Brand - Nail Polish - Lacquer Up", "Brand"), { shadeName: "Lacquer Up", productLine: "Nail Polish" });
});

test("strips the raw vendor prefix when the alias-resolved brand differs from it", () => {
  // Beyond Polish vendor "Lippmann" is aliased to the brand "Deborah Lippmann"; its titles start
  // with the raw vendor.
  partial(p("Lippmann - Celeste", "Deborah Lippmann", ["Lippmann"]), { shadeName: "Celeste" });
  partial(p("Deborah Lippmann - Celeste", "Deborah Lippmann", ["Lippmann"]), { shadeName: "Celeste" });
  partial(p("Sunday Studio - Nail Polish - No. 38", "Sundays", ["Sunday Studio"]), {
    shadeName: "No. 38", productLine: "Nail Polish",
  });
  // A single-segment title keeps the raw vendor in the shade name unless it is stripped.
  partial(p("Lippmann Celeste 0.5 oz", "Deborah Lippmann", ["Lippmann"]), { shadeName: "Celeste" });
  partial(p("Lippmann Celeste 0.5 oz", "Deborah Lippmann"), { shadeName: "Lippmann Celeste" });
});

test("reads a vendor code with a dot, and a code glued to the end of a segment", () => {
  // Beyond Polish, 2026-11-08: "Essie Gel Couture - Strut with it - #182.1", "Essie Skinny Dip 0.5 oz #1122".
  partial(p("Essie Gel Couture - Strut with it - #182.1", "Essie"), {
    shadeName: "Strut with it", productLine: "Gel Couture", vendorCode: "182.1",
  });
  partial(p("Essie Skinny Dip 0.5 oz #1122", "Essie"), { shadeName: "Skinny Dip", vendorCode: "1122" });
  partial(p("Zoya - Laurie .5 oz. - #ZP433", "Zoya"), { shadeName: "Laurie", vendorCode: "ZP433" });
});

test("keeps a short trailing number in the name, and trims a trailing dot from a code", () => {
  const lucky = p("Orly Lucky #7", "Orly");
  partial(lucky, { shadeName: "Lucky #7", vendorCode: null });
  partial(p("Essie Strut with it - #182.1", "Essie"), { vendorCode: "182.1" });
  partial(p("Essie Skinny Dip 0.5 oz #1122.", "Essie"), { shadeName: "Skinny Dip", vendorCode: "1122" });
  partial(p("Essie Skinny Dip - #1122.", "Essie"), { vendorCode: "1122" });
});

test("strips the longest matching brand prefix first (raw vendor before its alias target)", () => {
  // Alias target "Bee's Knees" is a prefix of the raw vendor "Bee's Knees Lacquer": the raw vendor wins,
  // so "Lacquer" never remains as a product line or the start of a shade name.
  partial(p("Bee's Knees Lacquer - The Pond Spirit", "Bee's Knees", ["Bee's Knees Lacquer"]), {
    shadeName: "The Pond Spirit", productLine: null,
  });
  partial(p("Bee's Knees Lacquer Some Shade", "Bee's Knees", ["Bee's Knees Lacquer"]), {
    shadeName: "Some Shade", productLine: null,
  });
});

test("strips trailing notes, Refill, Mini and sizes anywhere in a segment (Hypnotic / Beyond Polish 2026-11-08)", () => {
  partial(p("KBShimmer - Clearly On Top Quick Dry Top Coat 2oz (59ml) Refill", "KBShimmer"), {
    shadeName: "Clearly On Top Quick Dry Top Coat",
  });
  partial(p("Glisten & Glow - Refill Top Coat bottle 60 ml (2 oz)", "Glisten & Glow"), {
    shadeName: "Refill Top Coat bottle",
  });
  partial(p("Picture Polish - Always (Discontinued, last chance)", "Picture Polish"), { shadeName: "Always" });
  partial(p("Picture Polish - Always (Discontinued)", "Picture Polish"), { shadeName: "Always" });
  partial(p("Cirque Colors - Jammin' Out (LE)", "Cirque Colors"), { shadeName: "Jammin' Out" });
  partial(p("Cirque Colors - Jammin' Out (Limited Edition)", "Cirque Colors"), { shadeName: "Jammin' Out" });
  partial(p("Starrily - Golden Starlight (Reflective)", "Starrily"), { shadeName: "Golden Starlight" });
  partial(
    p("*PRE-ORDER* Cuticula Nail Lacquer - Limitless Quick Dry Top Coat (Unscented)", "Cuticula", ["Cuticula Nail Lacquer"]),
    { shadeName: "Limitless Quick Dry Top Coat", productLine: null }
  );
  partial(p("butter LONDON - Patent Shine - Empire Red Mini - 10X Nail Lacquer", "butter LONDON"), {
    shadeName: "Empire Red", productLine: "Patent Shine",
  });
  // Mini after a one-word name is part of the name.
  partial(p("Brand - Cooper Mini", "Brand"), { shadeName: "Cooper Mini" });
  partial(p("Brand - Ruby Red 0.5 fl oz", "Brand"), { shadeName: "Ruby Red" });
});

test("parseBrandStoreTitle parses only a title that starts with the brand, the raw vendor or a line word", () => {
  // A first segment that is not the brand is part of the shade name.
  partial(parseBrandStoreTitle("Polish Me Crazy - Pink", "Example Lacquer"), {
    shadeName: "Polish Me Crazy - Pink", productLine: null, vendorCode: null,
  });
  partial(parseBrandStoreTitle("Nail Lacquer - Red", "Example Lacquer"), { shadeName: "Red" });
  partial(parseBrandStoreTitle("Night Swim - Holo", "Example Lacquer"), {
    shadeName: "Night Swim - Holo", productLine: null, vendorCode: null,
  });
  partial(parseBrandStoreTitle("  Night Swim – Holo ", "Example Lacquer"), { shadeName: "Night Swim – Holo" });
  partial(parseBrandStoreTitle("OPI Nail Lacquer - Big Apple Red", "OPI"), {
    shadeName: "Big Apple Red", productLine: "Nail Lacquer",
  });
  partial(parseBrandStoreTitle("Zoya Nail Polish - Aurora", "Zoya"), { shadeName: "Aurora" });
  // En and em dashes separate like a hyphen.
  partial(parseBrandStoreTitle("Picture Polish – Atomic", "Picture Polish"), { shadeName: "Atomic" });
  partial(parseBrandStoreTitle("Picture Polish — Atomic", "picture polish"), { shadeName: "Atomic" });
  // The raw vendor when an alias renamed it.
  partial(parseBrandStoreTitle("Lippmann - Celeste", "Deborah Lippmann", "Lippmann"), { shadeName: "Celeste" });
  // A title starting with a line word.
  partial(parseBrandStoreTitle("Nail Lacquer - Big Apple Red - #NLA16", "OPI"), {
    shadeName: "Big Apple Red", vendorCode: "NLA16",
  });
  partial(parseBrandStoreTitle("Infinite Shine - Big Apple Red", "OPI"), { shadeName: "Big Apple Red" });
  // A one-segment title still loses its size and code.
  partial(parseBrandStoreTitle("Aurora 15ml #ZP123", "Zoya"), { shadeName: "Aurora", vendorCode: "ZP123" });
  assert.equal(parseBrandStoreTitle("   ", "Zoya"), null);
});

test("parseConnectorTitle reads brand stores with parseBrandStoreTitle and everything else with parseRetailerTitle", () => {
  partial(parseConnectorTitle("Night Swim - Holo", "Example Lacquer", "brand"), { shadeName: "Night Swim - Holo" });
  partial(parseConnectorTitle("Night Swim - Holo", "Example Lacquer", "retailer"), { shadeName: "Holo" });
  partial(parseConnectorTitle("Night Swim - Holo", "Example Lacquer", "feed"), { shadeName: "Holo" });
});
