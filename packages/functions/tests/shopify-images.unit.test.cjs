const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { normalizeShopifyImages } = require("../dist/lib/connectors/shopify-images");

describe("lib/connectors/shopify-images — normalizeShopifyImages", () => {
  it("keeps src, alt and position from Shopify image objects", () => {
    const images = normalizeShopifyImages([
      { id: 1, src: "https://cdn.shopify.com/a.jpg", alt: "Bottle hero", position: 1 },
      { id: 2, src: "https://cdn.shopify.com/b.jpg", alt: "Swatch on nails", position: 2 },
    ]);
    assert.deepEqual(images, [
      { url: "https://cdn.shopify.com/a.jpg", alt: "Bottle hero", position: 1 },
      { url: "https://cdn.shopify.com/b.jpg", alt: "Swatch on nails", position: 2 },
    ]);
  });

  it("accepts bare string entries and protocol-relative URLs", () => {
    assert.deepEqual(normalizeShopifyImages(["//cdn.shopify.com/a.jpg", { src: "//cdn.shopify.com/b.jpg" }]), [
      { url: "https://cdn.shopify.com/a.jpg", alt: null, position: null },
      { url: "https://cdn.shopify.com/b.jpg", alt: null, position: null },
    ]);
  });

  it("drops blanks, non-objects and duplicate URLs (first wins)", () => {
    const images = normalizeShopifyImages([
      null,
      42,
      { src: "   " },
      { src: "https://cdn.shopify.com/a.jpg", alt: "first", position: 1 },
      { src: "https://cdn.shopify.com/a.jpg", alt: "dupe", position: 2 },
      "",
    ]);
    assert.deepEqual(images, [{ url: "https://cdn.shopify.com/a.jpg", alt: "first", position: 1 }]);
  });

  it("normalizes alt whitespace and treats empty alt as null", () => {
    const images = normalizeShopifyImages([
      { src: "https://cdn.shopify.com/a.jpg", alt: "  two   coats\n on nails ", position: "3" },
      { src: "https://cdn.shopify.com/b.jpg", alt: "", position: 1.5 },
    ]);
    assert.equal(images[0].alt, "two coats on nails");
    assert.equal(images[0].position, 3);
    assert.equal(images[1].alt, null);
    assert.equal(images[1].position, null);
  });

  it("returns an empty list for non-array input", () => {
    assert.deepEqual(normalizeShopifyImages(undefined), []);
    assert.deepEqual(normalizeShopifyImages("https://cdn.shopify.com/a.jpg"), []);
  });
});
