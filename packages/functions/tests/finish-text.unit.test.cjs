/**
 * #352: finishes from product descriptors and description text (lib/finish-text.ts), the
 * tags > descriptors > description precedence, and how ingestion applies text-derived finishes
 * (fill only when the shade has none).
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// ---------------------------------------------------------------------------
// Fake ../lib/db for the materialization tests at the bottom. The catalog has an admin-created
// `chrome` finish type with an admin alias `mirror` → chrome.
// ---------------------------------------------------------------------------
const shadeUpdates = [];
let storedFinishes = [];

function fakeRows(sql, params) {
  if (sql.includes("FROM finish_normalization")) {
    return [
      ...["creme", "shimmer", "glitter", "holographic", "jelly", "matte", "chrome"].map((name) => ({
        kind: "type",
        sourceValue: name,
        normalizedFinishName: name,
      })),
      { kind: "alias", sourceValue: "holo", normalizedFinishName: "holographic" },
      { kind: "alias", sourceValue: "mirror", normalizedFinishName: "chrome" },
    ];
  }
  if (sql.includes("FROM brand")) return [{ brandId: 1 }];
  if (sql.includes('SELECT shade_id AS "shadeId", finishes')) {
    return [{ shadeId: 7, finishes: storedFinishes }];
  }
  if (sql.includes("UPDATE shade SET") && sql.includes("COALESCE($4::text[], finishes)")) {
    shadeUpdates.push(params[3] ?? storedFinishes);
    return [];
  }
  if (sql.includes("RETURNING")) return [{ inventoryItemId: 1, shadeId: 7, brandId: 1 }];
  return [];
}

const dbPath = path.resolve(__dirname, "../dist/lib/db.js");
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: {
    query: async (sql, params) => ({ rows: fakeRows(sql, params), rowCount: 0 }),
    transaction: async (cb) => cb({ query: async (sql, params) => ({ rows: fakeRows(sql, params), rowCount: 0 }) }),
  },
};

const {
  applyIngestedFinishes,
  parseFinishesFromDescriptors,
  parseFinishesFromText,
  resolveProductFinishes,
} = require("../dist/lib/finish-text");
const { loadFinishCatalog, resetFinishAliasCache } = require("../dist/lib/finishes");
const { materializeMakeupApiRecords, resolveIngestedShadeFinishResolution } = require("../dist/lib/ingestion-repo");

describe("parseFinishesFromText — description-only finishes", () => {
  it("finds finishes and aliases as whole words, in order of mention", () => {
    assert.deepEqual(parseFinishesFromText("A linear holo with gold shimmer."), ["holographic", "shimmer"]);
    assert.deepEqual(parseFinishesFromText("Squishy JELLY base packed with glitters!"), ["jelly", "glitter"]);
    assert.deepEqual(parseFinishesFromText("A glow-in-the-dark topper"), ["glow", "topper"]);
    assert.deepEqual(parseFinishesFromText("magnetic cat eye, thermal color change"), ["magnetic", "thermal"]);
  });

  it("does not match inside other words", () => {
    assert.deepEqual(parseFinishesFromText("A hologram-inspired, glittery mattress of colour"), []);
  });

  it("prefers the longest phrase: an alias for the whole phrase beats the words inside it", () => {
    assert.deepEqual(parseFinishesFromText("Loaded with holo glitter"), ["holographic"]);
  });

  it("never matches the `other` catch-all", () => {
    assert.deepEqual(parseFinishesFromText("Unlike other polishes it dries fast"), []);
  });

  it("handles non-strings and empty text", () => {
    assert.deepEqual(parseFinishesFromText(null), []);
    assert.deepEqual(parseFinishesFromText("   "), []);
  });
});

describe("parseFinishesFromText — false positives rejected", () => {
  it("negation within the clause", () => {
    assert.deepEqual(parseFinishesFromText("This is not a shimmer, it is a jelly."), ["jelly"]);
    assert.deepEqual(parseFinishesFromText("No glitter, just pure holo!"), ["holographic"]);
    assert.deepEqual(parseFinishesFromText("Without any shimmer"), []);
    assert.deepEqual(parseFinishesFromText("There is no visible shimmer in this creme"), ["creme"]);
    assert.deepEqual(parseFinishesFromText("It isn’t a glitter"), [], "curly apostrophe");
    assert.deepEqual(parseFinishesFromText("Shimmer-free creme formula"), ["creme"]);
    assert.deepEqual(parseFinishesFromText("glitter free and smooth"), []);
    assert.deepEqual(parseFinishesFromText("non-holo metallic"), ["metallic"], "non only negates the next word");
    assert.deepEqual(parseFinishesFromText("no holo or metallic here"), []);
  });

  it("cross-sell and layering sentences about other products", () => {
    assert.deepEqual(parseFinishesFromText("Pairs well with our glitter topper Stardust."), []);
    assert.deepEqual(
      parseFinishesFromText("A deep red creme. Layer it over a black jelly for a vampy look."),
      ["creme"]
    );
    assert.deepEqual(parseFinishesFromText("A linear holo, shown layered over our black creme."), ["holographic"]);
    assert.deepEqual(parseFinishesFromText("Try our holo topper over it!"), []);
    assert.deepEqual(parseFinishesFromText("Crelly base. You may also like: Galaxy Glitter"), ["crelly"]);
    assert.deepEqual(parseFinishesFromText("Matte jelly. Sister shade to our shimmer Nova."), ["matte", "jelly"]);
  });

  it("a cue only hides the rest of its own sentence (list items stay separate)", () => {
    assert.deepEqual(parseFinishesFromText("Pairs well with Onyx. Linear holo."), ["holographic"]);
  });

  it("a finish word naming a top or base coat is another product", () => {
    assert.deepEqual(parseFinishesFromText("Finish with our matte top coat for a velvet look"), []);
    assert.deepEqual(parseFinishesFromText("A shimmer; wear with a glossy topcoat"), ["shimmer"]);
  });

  it("ambiguous everyday words need finish context", () => {
    assert.deepEqual(parseFinishesFromText("Ice cream inspired pink"), []);
    assert.deepEqual(parseFinishesFromText("Gives your nails a gorgeous glow"), []);
    assert.deepEqual(parseFinishesFromText("Sheer joy in a bottle"), []);
    assert.deepEqual(parseFinishesFromText("A creamy pink formula"), ["creme"]);
    assert.deepEqual(parseFinishesFromText("A sheer pink polish"), ["sheer"]);
  });

  it("the brand is masked out when passed", () => {
    const text = "The Holo Taco signature formula: a jelly.";
    assert.deepEqual(parseFinishesFromText(text), ["holographic", "jelly"]);
    assert.deepEqual(parseFinishesFromText(text, undefined, { ignore: ["Holo Taco"] }), ["jelly"]);
  });
});

describe("parseFinishesFromDescriptors", () => {
  it("matches each descriptor on its own, skipping namespaces other than finish/type/effect/texture", () => {
    assert.deepEqual(
      parseFinishesFromDescriptors([
        "Nail Polish",
        "Holo Polish",
        "color:cream",
        "collection:Glitter Bomb",
        "type: Jelly",
        "Cream of the Crop",
        "Glow",
      ]),
      ["holographic", "jelly", "glow"]
    );
  });

  it("negation applies to descriptors too", () => {
    assert.deepEqual(parseFinishesFromDescriptors(["no-shimmer", "glitter-free"]), []);
  });

  it("returns [] for non-arrays", () => {
    assert.deepEqual(parseFinishesFromDescriptors("holo"), []);
  });
});

describe("runtime catalog (admin-created finish types and aliases)", () => {
  it("honors finish_type and finish_normalization rows", async () => {
    resetFinishAliasCache();
    const catalog = await loadFinishCatalog();
    assert.deepEqual(parseFinishesFromText("A mirror chrome powder look"), [], "not built-ins");
    assert.deepEqual(parseFinishesFromText("A true mirror finish", catalog), ["chrome"]);
    assert.deepEqual(parseFinishesFromText("Liquid chrome", catalog), ["chrome"]);
    assert.deepEqual(parseFinishesFromDescriptors(["Chrome Polish"], catalog), ["chrome"]);
    // `metallic` is a built-in but not a finish_type in this catalog.
    assert.deepEqual(parseFinishesFromText("A metallic jelly", catalog), ["jelly"]);
  });
});

describe("resolveProductFinishes — precedence", () => {
  it("tags win over descriptors and text", () => {
    assert.deepEqual(
      resolveProductFinishes({ tags: ["finish:matte"], descriptors: ["Holo Polish"], descriptionText: "A shimmer" }),
      { finishes: ["matte"], source: "tags" }
    );
  });

  it("descriptors are used when tags name no finish; text is ignored then", () => {
    assert.deepEqual(
      resolveProductFinishes({ tags: ["nail-polish"], descriptors: ["Linear Holo"], descriptionText: "with glitter" }),
      { finishes: ["holographic"], source: "descriptors" }
    );
  });

  it("description text only when tags and descriptors name none", () => {
    assert.deepEqual(resolveProductFinishes({ tags: [], descriptors: ["Nail Polish"], descriptionText: "A jelly" }), {
      finishes: ["jelly"],
      source: "description",
    });
    assert.deepEqual(resolveProductFinishes({}), { finishes: [], source: "none" });
  });

  it("masks the brand", () => {
    assert.deepEqual(
      resolveProductFinishes({ descriptors: ["Holo Taco"], descriptionText: "Holo Taco classic", brand: "Holo Taco" }),
      { finishes: [], source: "none" }
    );
  });

  it("resolveIngestedShadeFinishResolution reads the stored normalized_json fields", () => {
    assert.deepEqual(
      resolveIngestedShadeFinishResolution({
        brand: "Holo Taco",
        tags: ["nail-polish"],
        descriptors: ["Holo Taco"],
        descriptionText: "A Holo Taco crelly with micro-holo.",
      }),
      { finishes: ["crelly", "holographic"], source: "description" }
    );
    assert.deepEqual(resolveIngestedShadeFinishResolution(null), { finishes: [], source: "none" });
  });
});

describe("applyIngestedFinishes", () => {
  it("merges tag finishes into the current ones (unchanged ingestion behavior)", () => {
    assert.deepEqual(applyIngestedFinishes(["creme"], { finishes: ["shimmer"], source: "tags" }), ["creme", "shimmer"]);
  });

  it("text-derived finishes only fill a shade with no finishes", () => {
    assert.deepEqual(applyIngestedFinishes([], { finishes: ["jelly"], source: "description" }), ["jelly"]);
    assert.deepEqual(applyIngestedFinishes(null, { finishes: ["jelly"], source: "descriptors" }), ["jelly"]);
    assert.equal(applyIngestedFinishes(["creme"], { finishes: ["jelly"], source: "description" }), null);
    assert.equal(applyIngestedFinishes(["creme"], { finishes: ["jelly"], source: "descriptors" }), null);
  });

  it("nothing found leaves finishes untouched", () => {
    assert.equal(applyIngestedFinishes([], { finishes: [], source: "none" }), null);
  });
});

describe("materializeMakeupApiRecords — description finishes", () => {
  function record(normalized) {
    return {
      externalId: "mk-9",
      raw: {},
      normalized: { brand: "Example", name: "Prism", colorVariants: [{ name: "Prism", hex: "#aabbcc" }], ...normalized },
    };
  }

  it("fills an empty shade from the description when tags and descriptors name no finish", async () => {
    resetFinishAliasCache();
    shadeUpdates.length = 0;
    storedFinishes = [];
    await materializeMakeupApiRecords(1, [
      record({ tags: ["Vegan"], descriptors: ["nail_polish", "Vegan"], descriptionText: "A squishy jelly." }),
    ]);
    assert.deepEqual(shadeUpdates, [["jelly"]]);
  });

  it("never adds description finishes to a shade that already has finishes", async () => {
    resetFinishAliasCache();
    shadeUpdates.length = 0;
    storedFinishes = ["creme"];
    await materializeMakeupApiRecords(1, [record({ tags: [], descriptors: [], descriptionText: "A jelly." })]);
    assert.deepEqual(shadeUpdates, [["creme"]], "COALESCE(NULL, finishes) keeps the stored value");
  });

  it("tag finishes still merge into existing finishes", async () => {
    resetFinishAliasCache();
    shadeUpdates.length = 0;
    storedFinishes = ["creme"];
    await materializeMakeupApiRecords(1, [record({ tags: ["holo"], descriptionText: "A jelly." })]);
    assert.deepEqual(shadeUpdates, [["creme", "holographic"]]);
  });
});
