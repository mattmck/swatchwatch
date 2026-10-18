/**
 * #352: every connector keeps the product description (`descriptionText`) and descriptors in
 * `normalized_json`, built by the shared helpers in lib/product-text.ts.
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  PRODUCT_DESCRIPTION_MAX_CHARS,
  PRODUCT_DESCRIPTORS_MAX,
  PRODUCT_DESCRIPTOR_MAX_CHARS,
  htmlToPlainText,
  makeupApiProductText,
  normalizeDescriptors,
  openBeautyFactsProductText,
  readProductText,
  shopifyProductText,
  truncateText,
} = require("../dist/lib/product-text");

describe("lib/product-text — htmlToPlainText", () => {
  it("returns null for empty or non-string input", () => {
    assert.equal(htmlToPlainText(null), null);
    assert.equal(htmlToPlainText(""), null);
    assert.equal(htmlToPlainText(42), null);
    assert.equal(htmlToPlainText("<p> </p><br>"), null);
  });

  it("never leaves a NUL in the output (jsonb rejects \\u0000)", () => {
    assert.equal(htmlToPlainText("<br><br>A jelly"), "A jelly");
    assert.equal(htmlToPlainText("<br>\n<br>A jelly"), "A jelly");
    assert.equal(htmlToPlainText("<br><br><br>A jelly<br><br>"), "A jelly.");
    assert.equal(htmlToPlainText("A\u0000jelly<br>holo"), "A jelly. holo");
    assert.equal(htmlToPlainText("A\u0000jelly", undefined, { sentenceBreaks: false }), "A jelly");
    for (const html of ["<br><br>A", "<li></li><li>B</li>", "\u0000<br>\u0000C"]) {
      assert.ok(!htmlToPlainText(html).includes("\u0000"), JSON.stringify(html));
    }
  });

  it("strips tags, scripts, styles and comments; decodes named and numeric entities", () => {
    const text = htmlToPlainText(
      "<style>.x{color:red}</style><p>A <strong>linear&nbsp;holo</strong> with gold shimmer&#8230; it&rsquo;s &#x2018;magic&#x2019; &amp; more</p><!-- hidden --><script>alert('no')</script>"
    );
    assert.equal(text, "A linear holo with gold shimmer… it's ‘magic’ & more.");
  });

  it("does not leave a space before punctuation where an inline tag closed", () => {
    assert.equal(htmlToPlainText("A squishy <b>jelly</b>, with <i>holo</i>."), "A squishy jelly, with holo.");
  });

  it("ends a sentence at block ends so list items stay separate", () => {
    const text = htmlToPlainText("<ul><li>Pairs well with Onyx</li><li>Linear holo</li></ul><p>Done!</p>");
    assert.equal(text, "Pairs well with Onyx. Linear holo. Done!");
  });

  it("can turn block ends into plain spaces instead", () => {
    const text = htmlToPlainText("<p>A deep berry creme.</p><ul><li>2 coats</li><li>Vegan</li></ul>", 2000, {
      sentenceBreaks: false,
    });
    assert.equal(text, "A deep berry creme. 2 coats Vegan");
  });

  it("caps long text with an ellipsis at a word boundary", () => {
    const text = htmlToPlainText(`<p>${"shimmer ".repeat(500)}</p>`);
    assert.ok(text.length <= PRODUCT_DESCRIPTION_MAX_CHARS, `length ${text.length}`);
    assert.ok(text.endsWith("shimmer…"));
  });
});

describe("lib/product-text — truncateText", () => {
  it("leaves short text alone and cuts long text to the budget", () => {
    assert.equal(truncateText("short", 10), "short");
    const cut = truncateText("alpha beta gamma delta", 12);
    assert.ok(cut.length <= 12);
    assert.equal(cut, "alpha beta…");
  });
});

describe("lib/product-text — normalizeDescriptors", () => {
  it("trims, collapses whitespace, dedupes case-insensitively and drops placeholders and hexes", () => {
    assert.deepEqual(
      normalizeDescriptors(["  Nail   Polish ", "nail polish", "Default Title", "Title", "#AABBCC", "", null, 7, "Holo"]),
      ["Nail Polish", "7", "Holo"]
    );
  });

  it("caps the count and the length of each descriptor", () => {
    const many = Array.from({ length: 100 }, (_, i) => `tag-${i}`);
    assert.equal(normalizeDescriptors(many).length, PRODUCT_DESCRIPTORS_MAX);
    const [long] = normalizeDescriptors(["x".repeat(500)]);
    assert.ok(long.length <= PRODUCT_DESCRIPTOR_MAX_CHARS);
  });
});

describe("lib/product-text — per-connector extractors", () => {
  it("shopifyProductText: body_html, product type, options, variant values, tags, collections", () => {
    const text = shopifyProductText({
      body_html: "<p>A <em>scattered holo</em> jelly.</p>",
      product_type: "Nail Polish",
      options: [{ name: "Size", values: ["Full", "Mini"] }],
      variants: [{ option1: "Full" }, { option1: "Mini", option2: "Default Title" }],
      tags: "collection:Summer Holo, nail-polish, Jelly",
    });
    assert.equal(text.descriptionText, "A scattered holo jelly.");
    assert.deepEqual(text.descriptors, [
      "Nail Polish",
      "Size",
      "Full",
      "Mini",
      "collection:Summer Holo",
      "nail-polish",
      "Jelly",
      "Summer Holo",
    ]);
  });

  it("makeupApiProductText: description, product type, category, tag list (not colour names)", () => {
    const text = makeupApiProductText({
      description: "Long-wear <b>matte</b> lacquer",
      product_type: "nail_polish",
      category: null,
      tag_list: ["Vegan", "Natural"],
      product_colors: [{ colour_name: "Shimmer Pink" }],
    });
    assert.equal(text.descriptionText, "Long-wear matte lacquer");
    assert.deepEqual(text.descriptors, ["nail_polish", "Vegan", "Natural"]);
  });

  it("openBeautyFactsProductText: generic name unless it repeats the product name; taxonomy tags", () => {
    const text = openBeautyFactsProductText({
      product_name: "Super Shine",
      generic_name: "Vernis à ongles pailleté",
      categories_tags: ["en:nail-polishes", "fr:vernis-a-ongles"],
      labels_tags: ["en:vegan"],
    });
    assert.equal(text.descriptionText, "Vernis à ongles pailleté");
    assert.deepEqual(text.descriptors, ["nail polishes", "vernis a ongles", "vegan"]);

    const same = openBeautyFactsProductText({ product_name: "Nail Polish", generic_name: "nail polish" });
    assert.equal(same.descriptionText, null);

    const localized = openBeautyFactsProductText({ product_name: "X", generic_name: "", generic_name_en: "Glitter polish" });
    assert.equal(localized.descriptionText, "Glitter polish");
  });

  it("readProductText reads stored fields and tolerates rows from before #352", () => {
    assert.deepEqual(readProductText({ descriptionText: " Holo ", descriptors: ["a", "A", 3] }), {
      descriptionText: "Holo",
      descriptors: ["a", "3"],
    });
    assert.deepEqual(readProductText({}), { descriptionText: null, descriptors: [] });
    assert.deepEqual(readProductText(null), { descriptionText: null, descriptors: [] });
  });
});

describe("connectors write descriptionText and descriptors into normalized", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  function stubShopifyFetch(products) {
    global.fetch = async (url) => {
      const page = new URL(url).searchParams.get("page");
      const body = JSON.stringify({ products: page === "1" ? products : [] });
      return { ok: true, status: 200, statusText: "OK", text: async () => body };
    };
  }

  const shopifyProduct = {
    id: 9,
    title: "Nebula",
    handle: "nebula",
    vendor: "Indie",
    product_type: "Nail Polish",
    body_html: "<p>A <strong>linear holo</strong> with gold shimmer.</p>",
    tags: ["nail-polish", "collection:Space"],
    options: [{ name: "Size", values: ["15ml"] }],
    variants: [{ id: 1, option1: "15ml" }],
    images: [],
  };

  it("ShopifyGenericConnector", async () => {
    const { ShopifyGenericConnector } = require("../dist/lib/connectors/shopify-generic");
    stubShopifyFetch([shopifyProduct]);
    const connector = new ShopifyGenericConnector("MooncatShopify", "https://indie.example.test");
    const result = await connector.pullProducts({ searchTerm: "", page: 1, pageSize: 10, maxRecords: 10 });
    assert.equal(result.records.length, 1);
    const { normalized, raw } = result.records[0];
    assert.equal(normalized.descriptionText, "A linear holo with gold shimmer.");
    assert.deepEqual(normalized.descriptors, ["Nail Polish", "Size", "15ml", "nail-polish", "collection:Space", "Space"]);
    assert.equal(raw.body_html, shopifyProduct.body_html, "raw_json keeps the original payload");
  });

  it("HoloTacoShopifyConnector", async () => {
    const { HoloTacoShopifyConnector } = require("../dist/lib/connectors/holo-taco-shopify");
    stubShopifyFetch([{ ...shopifyProduct, vendor: "Holo Taco" }]);
    const connector = new HoloTacoShopifyConnector("https://example.test");
    const result = await connector.pullProducts({ searchTerm: "", page: 1, pageSize: 10, maxRecords: 10 });
    assert.equal(result.records.length, 1);
    const { normalized } = result.records[0];
    assert.equal(normalized.descriptionText, "A linear holo with gold shimmer.");
    assert.ok(normalized.descriptors.includes("Nail Polish"));
    assert.ok(normalized.descriptors.includes("Space"));
  });

  it("MakeupApiConnector", async () => {
    const { MakeupApiConnector } = require("../dist/lib/connectors/makeup-api");
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => [
        {
          id: 5,
          brand: "zoya",
          name: "Pixie Dust",
          description: "<p>Textured <b>glitter</b> polish.</p>",
          product_type: "nail_polish",
          tag_list: ["Vegan"],
          product_colors: [],
        },
      ],
    });
    const result = await new MakeupApiConnector().pullProducts({ searchTerm: "", page: 1, pageSize: 10, maxRecords: 10 });
    const { normalized } = result.records[0];
    assert.equal(normalized.descriptionText, "Textured glitter polish.");
    assert.deepEqual(normalized.descriptors, ["nail_polish", "Vegan"]);
  });

  it("OpenBeautyFactsConnector", async () => {
    const { OpenBeautyFactsConnector } = require("../dist/lib/connectors/open-beauty-facts");
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        products: [
          {
            code: "0123456789012",
            product_name: "Gel Shine",
            generic_name: "Shimmer nail polish",
            categories_tags: ["en:nail-polishes"],
            labels_tags: [],
          },
        ],
      }),
    });
    const result = await new OpenBeautyFactsConnector().pullProducts({
      searchTerm: "nail polish",
      page: 1,
      pageSize: 10,
      maxRecords: 10,
    });
    const { normalized } = result.records[0];
    assert.equal(normalized.descriptionText, "Shimmer nail polish");
    assert.deepEqual(normalized.descriptors, ["nail polishes"]);
  });
});
