/**
 * Color family classifier (#103): `classifyColorFamily` & co. in packages/shared, and the
 * Postgres mirror `shade_color_family()` in migration 20261017061637910_add-shade-color-family
 * that keeps the generated `shade.color_family` column (what ?family= filters on) current.
 *
 * Runs without a database. The TS ↔ SQL sync is checked structurally (every threshold
 * CONSTANT and the multichrome finish list are parsed out of the migration and compared to
 * the TS exports); when COLOR_FAMILY_SQL_TEST_DATABASE_URL points at a migrated database (read-only) the bins are also compared
 * row for row over a grid of hexes.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  COLOR_FAMILIES,
  COLOR_FAMILY_LABELS,
  COLOR_FAMILY_SWATCH_HEX,
  COLOR_FAMILY_THRESHOLDS,
  MULTICHROME_FAMILY_FINISHES,
  classifyColorFamily,
  classifyHexColorFamily,
  classifyOklchColorFamily,
  hasMultichromeFinish,
  hexToOklch,
  isColorFamily,
} = require("swatchwatch-shared");

const MIGRATION_PATH = path.resolve(
  __dirname,
  "../migrations/20261017061637910_add-shade-color-family.sql"
);

function family(hex) {
  return classifyHexColorFamily(hex);
}

function expectFamilies(cases) {
  for (const [name, hex, expected] of cases) {
    assert.equal(family(hex), expected, `${name} ${hex} (${JSON.stringify(hexToOklch(hex))})`);
  }
}

describe("color family — vocabulary", () => {
  it("has the 15 families from the roadmap, each with a label and swatch", () => {
    assert.deepEqual([...COLOR_FAMILIES], [
      "red", "pink", "coral", "orange", "yellow", "green", "teal", "blue", "purple",
      "nude", "brown", "grey", "black", "white", "multichrome",
    ]);
    for (const f of COLOR_FAMILIES) {
      assert.equal(typeof COLOR_FAMILY_LABELS[f], "string");
      assert.match(COLOR_FAMILY_SWATCH_HEX[f], /^#[0-9A-F]{6}$/);
    }
  });

  it("each chip swatch hex classifies into its own family (multichrome is finish-driven)", () => {
    for (const f of COLOR_FAMILIES) {
      if (f === "multichrome") continue;
      assert.equal(family(COLOR_FAMILY_SWATCH_HEX[f]), f, `swatch for ${f}`);
    }
  });

  it("isColorFamily accepts only exact family names", () => {
    assert.equal(isColorFamily("red"), true);
    assert.equal(isColorFamily("multichrome"), true);
    assert.equal(isColorFamily("Red"), false);
    assert.equal(isColorFamily("gray"), false);
    assert.equal(isColorFamily(""), false);
    assert.equal(isColorFamily(null), false);
  });
});

describe("color family — typical polish colors", () => {
  it("bins reds, pinks, corals, oranges", () => {
    expectFamilies([
      ["red", "#FF0000", "red"],
      ["crimson", "#DC143C", "red"],
      ["cherry", "#D2042D", "red"],
      ["maroon", "#800000", "red"],
      ["burgundy", "#800020", "red"],
      ["wine", "#722F37", "red"],
      ["oxblood", "#4A0404", "red"],
      ["hot pink", "#FF69B4", "pink"],
      ["deep pink", "#FF1493", "pink"],
      ["baby pink", "#F4C2C2", "pink"],
      ["pastel pink", "#FFD1DC", "pink"],
      ["fuchsia", "#FF00FF", "pink"],
      ["raspberry", "#E30B5C", "pink"],
      ["coral", "#FF7F50", "coral"],
      ["living coral", "#FF6F61", "coral"],
      ["salmon", "#FA8072", "coral"],
      ["light salmon", "#FFA07A", "coral"],
      ["orange", "#FFA500", "orange"],
      ["dark orange", "#FF8C00", "orange"],
      ["pumpkin", "#FF7518", "orange"],
      ["tangerine", "#F28500", "orange"],
      ["burnt orange", "#CC5500", "orange"],
      ["rust", "#B7410E", "orange"],
    ]);
  });

  it("bins yellows, greens, teals, blues, purples", () => {
    expectFamilies([
      ["yellow", "#FFFF00", "yellow"],
      ["gold", "#FFD700", "yellow"],
      ["mustard", "#FFDB58", "yellow"],
      ["amber", "#FFBF00", "yellow"],
      ["green", "#00FF00", "green"],
      ["forest", "#228B22", "green"],
      ["mint", "#98FF98", "green"],
      ["sage", "#9CAF88", "green"],
      ["olive", "#808000", "green"],
      ["emerald", "#50C878", "green"],
      ["teal", "#008080", "teal"],
      ["turquoise", "#40E0D0", "teal"],
      ["tiffany", "#0ABAB5", "teal"],
      ["blue", "#0000FF", "blue"],
      ["navy", "#000080", "blue"],
      ["sky", "#87CEEB", "blue"],
      ["powder blue", "#B0E0E6", "blue"],
      ["periwinkle", "#CCCCFF", "blue"],
      ["cobalt", "#0047AB", "blue"],
      ["purple", "#800080", "purple"],
      ["indigo", "#4B0082", "purple"],
      ["dark violet", "#9400D3", "purple"],
      ["amethyst", "#9966CC", "purple"],
      ["lilac", "#C8A2C8", "purple"],
      ["pale lavender", "#DCD0FF", "purple"],
      ["eggplant", "#614051", "purple"],
      ["aubergine", "#3D0734", "purple"],
    ]);
  });

  it("bins nudes, browns and neutrals", () => {
    expectFamilies([
      ["nude", "#E3BC9A", "nude"],
      ["tan", "#D2B48C", "nude"],
      ["peach", "#FFDAB9", "nude"],
      ["latte", "#C5A48A", "nude"],
      ["pink nude", "#E6BEB4", "nude"],
      ["brown", "#8B4513", "brown"],
      ["sienna", "#A0522D", "brown"],
      ["chocolate brown", "#7B3F00", "brown"],
      ["coffee", "#6F4E37", "brown"],
      ["caramel", "#AF6E4D", "brown"],
      ["black", "#000000", "black"],
      ["off-black", "#1C1C1C", "black"],
      ["white", "#FFFFFF", "white"],
      ["off-white", "#FAF9F6", "white"],
      ["ivory", "#FFFFF0", "white"],
      ["grey", "#808080", "grey"],
      ["silver", "#C0C0C0", "grey"],
      ["charcoal", "#36454F", "grey"],
    ]);
  });

  it("accepts lowercase and #-less hexes; invalid hexes have no family", () => {
    assert.equal(family("ff0000"), "red");
    assert.equal(family("  #ff0000 "), "red");
    // trim() strips all ECMAScript whitespace (tabs, newlines, NBSP, BOM, ...), not just spaces.
    assert.equal(family("\t#FF0000\n"), "red");
    assert.equal(family(" ﻿#FF0000　\r\n"), "red");
    assert.equal(family("​#FF0000"), null); // zero-width space is not whitespace
    assert.equal(family("#F00"), null);
    assert.equal(family("not-a-hex"), null);
    assert.equal(family(""), null);
    assert.equal(family(null), null);
    assert.equal(family(undefined), null);
  });
});

describe("color family — boundaries", () => {
  it("near-grays: tiny chroma is grey; dark near-grays are black, very light are white", () => {
    expectFamilies([
      ["greige", "#A89F91", "grey"], // C ≈ 0.023, warm but nearly neutral
      ["bone", "#E3DAC9", "grey"], // C ≈ 0.025
      ["taupe", "#483C32", "grey"], // C ≈ 0.024, L ≈ 0.37
      ["gunmetal", "#2A3439", "grey"], // L ≈ 0.318, just above black
      ["light gray", "#D3D3D3", "grey"],
      ["platinum", "#E5E4E2", "grey"], // L ≈ 0.919, just below white
      ["lavender gray", "#C4C3D0", "grey"],
      ["slate", "#708090", "blue"], // C ≈ 0.031, just chromatic enough for blue
      ["near black with blue", "#0B0B1E", "black"], // L ≈ 0.16, C ≈ 0.039
      ["near black brown", "#1A1110", "black"],
      ["very dark brown", "#2C1608", "brown"], // L ≈ 0.228 escapes the black band
      ["dark navy-ish", "#1B1B3A", "blue"], // L ≈ 0.24, C ≈ 0.058
      ["ghost white", "#F8F8FF", "white"],
      ["seashell", "#FFF5EE", "white"],
      ["beige", "#F5F5DC", "white"], // pale tint (L ≥ 0.96, C < 0.06)
      ["cream", "#FFFDD0", "white"],
      ["butter", "#FFFF99", "yellow"], // light but saturated
    ]);
  });

  it("nude vs brown: the same warm low-chroma color splits on lightness 0.70", () => {
    const t = COLOR_FAMILY_THRESHOLDS;
    const h = 55;
    const C = 0.06;
    assert.equal(classifyOklchColorFamily({ L: t.nudeMinLightness, C, h }), "nude");
    assert.equal(classifyOklchColorFamily({ L: t.nudeMinLightness - 0.001, C, h }), "brown");
    expectFamilies([
      ["mocha nude", "#B78A75", "brown"], // L ≈ 0.671
      ["camel", "#C19A6B", "nude"], // L ≈ 0.711
      ["dusty nude", "#C9A08F", "nude"],
      ["copper", "#B87333", "brown"],
    ]);
  });

  it("nude vs orange/coral/yellow: more chroma leaves nude", () => {
    const t = COLOR_FAMILY_THRESHOLDS;
    assert.equal(classifyOklchColorFamily({ L: 0.8, C: t.nudeMaxChroma, h: 60 }), "nude");
    assert.equal(classifyOklchColorFamily({ L: 0.8, C: t.nudeMaxChroma + 0.001, h: 60 }), "orange");
    assert.equal(classifyOklchColorFamily({ L: 0.8, C: t.nudeMaxChroma + 0.001, h: 30 }), "coral");
    assert.equal(classifyOklchColorFamily({ L: 0.9, C: 0.06, h: 99.9 }), "nude");
    assert.equal(classifyOklchColorFamily({ L: 0.9, C: 0.06, h: 100 }), "yellow");
    expectFamilies([
      ["fawn", "#E5AA70", "orange"], // C ≈ 0.102
      ["dark salmon", "#E9967A", "coral"],
      ["khaki", "#F0E68C", "yellow"],
      ["pearl", "#EAE0C8", "nude"],
    ]);
  });

  it("nude vs pink: warm pastels are nude, cool (h < 20) pastels are pink", () => {
    assert.equal(classifyOklchColorFamily({ L: 0.85, C: 0.05, h: 20 }), "nude");
    assert.equal(classifyOklchColorFamily({ L: 0.85, C: 0.05, h: 19.9 }), "pink");
    expectFamilies([
      ["blush beige", "#E8C4C0", "nude"], // h ≈ 25.5
      ["pale pink", "#FADADD", "pink"], // h ≈ 11
      ["rosy brown", "#BC8F8F", "pink"], // h ≈ 18.6 (dusty rose)
    ]);
  });

  it("coral vs red/orange/pink: coral is the light band between pink (h < 20) and orange (h ≥ 45)", () => {
    const t = COLOR_FAMILY_THRESHOLDS;
    // Lightness splits coral from red (h < 36) and orange (36 ≤ h < 45).
    assert.equal(classifyOklchColorFamily({ L: t.coralMinLightness, C: 0.18, h: 30 }), "coral");
    assert.equal(classifyOklchColorFamily({ L: t.coralMinLightness - 0.001, C: 0.18, h: 30 }), "red");
    assert.equal(classifyOklchColorFamily({ L: t.coralMinLightness - 0.001, C: 0.18, h: 40 }), "orange");
    // Hue splits coral from orange and pink.
    assert.equal(classifyOklchColorFamily({ L: 0.75, C: 0.18, h: 44.9 }), "coral");
    assert.equal(classifyOklchColorFamily({ L: 0.75, C: 0.18, h: 45 }), "orange");
    assert.equal(classifyOklchColorFamily({ L: 0.75, C: 0.18, h: 20 }), "coral");
    assert.equal(classifyOklchColorFamily({ L: 0.75, C: 0.18, h: 19.9 }), "pink");
    expectFamilies([
      ["sunset", "#FD5E53", "coral"], // L ≈ 0.689
      ["terracotta", "#E2725B", "red"], // L ≈ 0.677
      ["tomato red", "#E03C31", "red"],
      ["light coral", "#F08080", "coral"],
      ["indian red", "#CD5C5C", "red"],
    ]);
  });

  it("very dark colors keep their hue family unless nearly neutral", () => {
    const t = COLOR_FAMILY_THRESHOLDS;
    assert.equal(classifyOklchColorFamily({ L: 0.15, C: t.darkBlackMaxChroma - 0.001, h: 260 }), "black");
    assert.equal(classifyOklchColorFamily({ L: 0.15, C: t.darkBlackMaxChroma, h: 260 }), "blue");
    assert.equal(classifyOklchColorFamily({ L: t.darkBlackMaxLightness, C: 0.05, h: 260 }), "blue");
    expectFamilies([
      ["vampy", "#3B0A1E", "red"],
      ["dark purple", "#301934", "purple"],
      ["dark teal", "#0F3D3E", "teal"],
      ["prussian", "#003153", "blue"],
      ["bistre", "#3D2B1F", "brown"],
    ]);
  });

  it("dark pinks are red (wine) or purple (eggplant), split at h 350", () => {
    const t = COLOR_FAMILY_THRESHOLDS;
    assert.equal(classifyOklchColorFamily({ L: t.darkPinkMaxLightness, C: 0.12, h: 355 }), "pink");
    assert.equal(classifyOklchColorFamily({ L: t.darkPinkMaxLightness - 0.001, C: 0.12, h: 355 }), "red");
    assert.equal(classifyOklchColorFamily({ L: 0.4, C: 0.12, h: 349.9 }), "purple");
    assert.equal(classifyOklchColorFamily({ L: 0.4, C: 0.12, h: 10 }), "red");
  });

  it("magenta band (320–340): light saturated → pink, else purple", () => {
    const t = COLOR_FAMILY_THRESHOLDS;
    assert.equal(classifyOklchColorFamily({ L: t.magentaPinkMinLightness, C: t.magentaPinkMinChroma, h: 330 }), "pink");
    assert.equal(classifyOklchColorFamily({ L: t.magentaPinkMinLightness - 0.001, C: 0.2, h: 330 }), "purple");
    assert.equal(classifyOklchColorFamily({ L: 0.75, C: t.magentaPinkMinChroma - 0.001, h: 330 }), "purple");
    expectFamilies([
      ["orchid", "#DA70D6", "pink"],
      ["dark magenta", "#8B008B", "purple"],
      ["opera mauve", "#B784A7", "purple"],
    ]);
  });

  it("dark yellows are brown below h 100 and olive green above", () => {
    const t = COLOR_FAMILY_THRESHOLDS;
    assert.equal(classifyOklchColorFamily({ L: t.oliveMaxLightness, C: 0.15, h: 95 }), "yellow");
    assert.equal(classifyOklchColorFamily({ L: t.oliveMaxLightness - 0.001, C: 0.15, h: 95 }), "brown");
    assert.equal(classifyOklchColorFamily({ L: t.oliveMaxLightness - 0.001, C: 0.15, h: 105 }), "green");
    expectFamilies([
      ["dark goldenrod", "#B8860B", "yellow"],
      ["army", "#4B5320", "green"],
    ]);
  });

  it("hue band edges", () => {
    const at = (h) => classifyOklchColorFamily({ L: 0.65, C: 0.15, h });
    assert.equal(at(79.9), "orange");
    assert.equal(at(80), "yellow");
    assert.equal(at(114.9), "yellow");
    assert.equal(at(115), "green");
    assert.equal(at(169.9), "green");
    assert.equal(at(170), "teal");
    assert.equal(at(204.9), "teal");
    assert.equal(at(205), "blue");
    assert.equal(at(289.9), "blue");
    assert.equal(at(290), "purple");
    assert.equal(at(319.9), "purple");
    assert.equal(at(339.9), "pink");
    assert.equal(at(340), "pink");
    assert.equal(at(0), "pink");
  });
});

describe("color family — shades (display hex + finishes)", () => {
  it("uses the display hex precedence vendor > detected > name", () => {
    assert.equal(classifyColorFamily({ vendorHex: "#FF0000", detectedHex: "#0000FF", nameHex: "#00FF00" }), "red");
    assert.equal(classifyColorFamily({ detectedHex: "#0000FF", nameHex: "#00FF00" }), "blue");
    assert.equal(classifyColorFamily({ vendorHex: "", detectedHex: null, nameHex: "#00FF00" }), "green");
    assert.equal(classifyColorFamily({}), null);
  });

  it("an invalid winning hex yields no family (same as Postgres; no fallback to the next column)", () => {
    assert.equal(classifyColorFamily({ vendorHex: "zzz", nameHex: "#0000FF" }), null);
  });

  it("multichrome comes from finishes, overrides the hex, and works without a hex", () => {
    assert.equal(classifyColorFamily({ vendorHex: "#FF0000", finishes: ["multichrome"] }), "multichrome");
    assert.equal(classifyColorFamily({ vendorHex: "#FF0000", finishes: ["shimmer", "multichrome"] }), "multichrome");
    assert.equal(classifyColorFamily({ finish: "multichrome", finishes: [] }), "multichrome");
    assert.equal(classifyColorFamily({ finish: " Chameleon " }), "multichrome");
    assert.equal(classifyColorFamily({ finishes: ["Color Shift"] }), "multichrome");
    assert.equal(classifyColorFamily({ finishes: ["\tMultichrome "] }), "multichrome");
    assert.equal(classifyColorFamily({ vendorHex: "#800080", finishes: ["duochrome"] }), "purple");
    assert.equal(classifyColorFamily({ vendorHex: "#800080", finish: "holographic", finishes: ["holographic"] }), "purple");
    assert.equal(hasMultichromeFinish({ finishes: null, finish: null }), false);
  });
});

describe("color family — TS ↔ Postgres sync", () => {
  const sql = fs.readFileSync(MIGRATION_PATH, "utf8");
  const up = sql.slice(0, sql.indexOf("-- Down Migration"));

  const toSnake = (key) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

  it("every COLOR_FAMILY_THRESHOLDS value is a CONSTANT with the same value in shade_color_family_from_hex()", () => {
    const constants = new Map(
      [...up.matchAll(/^\s*([a-z_]+)\s+CONSTANT double precision := ([0-9.]+);/gm)].map((m) => [m[1], Number(m[2])])
    );
    const tsKeys = Object.keys(COLOR_FAMILY_THRESHOLDS);
    assert.equal(constants.size, tsKeys.length, "same number of thresholds in TS and SQL");
    for (const key of tsKeys) {
      const snake = toSnake(key);
      assert.ok(constants.has(snake), `SQL is missing CONSTANT ${snake}`);
      assert.equal(constants.get(snake), COLOR_FAMILY_THRESHOLDS[key], `${snake} differs between TS and SQL`);
      // ...and the constant is actually used after its declaration.
      const uses = up.split(new RegExp(`\\b${snake}\\b`)).length - 1;
      assert.ok(uses >= 2, `${snake} is declared but never used in SQL`);
    }
  });

  it("the SQL multichrome finish list equals MULTICHROME_FAMILY_FINISHES", () => {
    const match = up.match(/ANY \(ARRAY\[([^\]]+)\]\)/);
    assert.ok(match, "shade_color_family() should compare finishes against an ARRAY literal");
    const sqlFinishes = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(sqlFinishes, [...MULTICHROME_FAMILY_FINISHES]);
  });

  it("the SQL returns exactly the 15 family names", () => {
    const returned = new Set([...up.matchAll(/RETURN '([a-z]+)'/g)].map((m) => m[1]));
    assert.deepEqual([...returned].sort(), [...COLOR_FAMILIES].sort());
  });

  it("the generated column uses vendor > detected > name and both finish columns", () => {
    assert.match(
      up,
      /GENERATED ALWAYS AS \(shade_color_family\(vendor_hex, detected_hex, name_hex, finishes, finish\)\) STORED/
    );
    assert.match(up, /COALESCE\(NULLIF\(p_vendor_hex, ''\), NULLIF\(p_detected_hex, ''\), NULLIF\(p_name_hex, ''\)\)/);
  });

  it(
    "matches Postgres shade_color_family_from_hex() over a hex grid (needs COLOR_FAMILY_SQL_TEST_DATABASE_URL)",
    { skip: !process.env.COLOR_FAMILY_SQL_TEST_DATABASE_URL && "COLOR_FAMILY_SQL_TEST_DATABASE_URL not set" },
    async () => {
      const { Client } = require("pg");
      const client = new Client({ connectionString: process.env.COLOR_FAMILY_SQL_TEST_DATABASE_URL });
      await client.connect();
      try {
        const hexes = [];
        for (let r = 0; r < 256; r += 15)
          for (let g = 0; g < 256; g += 15)
            for (let b = 0; b < 256; b += 15)
              hexes.push(`#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase()}`);
        hexes.push(...Object.values(COLOR_FAMILY_SWATCH_HEX));
        const { rows } = await client.query(
          "SELECT h, shade_color_family_from_hex(h) AS f FROM unnest($1::text[]) AS h",
          [hexes]
        );
        const mismatches = rows.filter((row) => classifyHexColorFamily(row.h) !== row.f);
        assert.deepEqual(mismatches.slice(0, 10), []);
      } finally {
        await client.end();
      }
    }
  );
});
