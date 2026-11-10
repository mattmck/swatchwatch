/**
 * Per-product image download cap (`SOURCE_IMAGE_MAX_PER_PRODUCT`, lib/product-image-cap.ts):
 * which of a product's listed images ingestion downloads and stores.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_SOURCE_IMAGE_MAX_PER_PRODUCT,
  MAX_SOURCE_IMAGE_MAX_PER_PRODUCT,
  getSourceImageMaxPerProduct,
  planProductImageDownloads,
} = require("../dist/lib/product-image-cap");

describe("getSourceImageMaxPerProduct", () => {
  it("defaults to 8 when unset, empty, zero or invalid (never unlimited)", () => {
    assert.equal(DEFAULT_SOURCE_IMAGE_MAX_PER_PRODUCT, 8);
    for (const raw of [undefined, "", "  ", "0", "-3", "abc", "2.5", "unlimited"]) {
      const env = raw === undefined ? {} : { SOURCE_IMAGE_MAX_PER_PRODUCT: raw };
      assert.equal(getSourceImageMaxPerProduct(env), 8, `value ${JSON.stringify(raw)}`);
    }
  });

  it("reads a positive integer and clamps it to the maximum", () => {
    assert.equal(getSourceImageMaxPerProduct({ SOURCE_IMAGE_MAX_PER_PRODUCT: " 3 " }), 3);
    assert.equal(getSourceImageMaxPerProduct({ SOURCE_IMAGE_MAX_PER_PRODUCT: "1" }), 1);
    assert.equal(
      getSourceImageMaxPerProduct({ SOURCE_IMAGE_MAX_PER_PRODUCT: "5000" }),
      MAX_SOURCE_IMAGE_MAX_PER_PRODUCT
    );
  });
});

const url = (i) => `https://shop.example/img-${i}.jpg`;
const urls = (n) => Array.from({ length: n }, (_, i) => url(i));

describe("planProductImageDownloads", () => {
  it("keeps every image of a product under the cap, in vendor order", () => {
    const imageUrls = urls(5);
    const plan = planProductImageDownloads({ imageUrls, images: [], primaryUrl: imageUrls[0], maxImages: 8 });
    assert.deepEqual(
      plan.additional.map((entry) => entry.url),
      imageUrls.slice(1)
    );
    assert.deepEqual(plan.additional.map((entry) => entry.index), [1, 2, 3, 4]);
    assert.equal(plan.skippedByCap.length, 0);
    assert.equal(plan.detectionUrl, null);
  });

  it("keeps the primary and the first images in vendor order up to the cap", () => {
    const imageUrls = urls(12);
    const plan = planProductImageDownloads({ imageUrls, images: [], primaryUrl: imageUrls[0], maxImages: 4 });
    assert.deepEqual(plan.additional.map((entry) => entry.url), imageUrls.slice(1, 4));
    assert.deepEqual(plan.skippedByCap, imageUrls.slice(4));
  });

  it("keeps the likely on-nail photo AI detection would choose, even past the cap", () => {
    const imageUrls = urls(12);
    const images = imageUrls.map((u, i) => ({ url: u, alt: i === 10 ? "Swatch on nails" : "Bottle", position: i + 1 }));
    const plan = planProductImageDownloads({ imageUrls, images, primaryUrl: imageUrls[0], maxImages: 4 });

    assert.equal(plan.detectionUrl, imageUrls[10]);
    // Primary + detection image + the first two others: still 4 in all, in vendor order.
    assert.deepEqual(plan.additional.map((entry) => entry.url), [imageUrls[1], imageUrls[2], imageUrls[10]]);
    assert.deepEqual(plan.additional.map((entry) => entry.index), [1, 2, 10]);
    assert.equal(plan.skippedByCap.length, 8);
    assert.ok(!plan.skippedByCap.includes(imageUrls[10]));
  });

  it("keeps the detection photo on top of the primary when the cap is 1", () => {
    const imageUrls = urls(6);
    const images = imageUrls.map((u, i) => ({ url: u, alt: i === 4 ? "hand swatch" : null, position: i + 1 }));
    const plan = planProductImageDownloads({ imageUrls, images, primaryUrl: imageUrls[0], maxImages: 1 });
    assert.deepEqual(plan.additional.map((entry) => entry.url), [imageUrls[4]]);
    assert.equal(plan.skippedByCap.length, 4);
  });

  it("does not pin an image without a confident alt-text signal (the primary is the detection image)", () => {
    const imageUrls = [url(0), url(1), "https://shop.example/hand_macro.jpg", url(3)];
    const plan = planProductImageDownloads({ imageUrls, images: [], primaryUrl: imageUrls[0], maxImages: 2 });
    assert.equal(plan.detectionUrl, null);
    assert.deepEqual(plan.additional.map((entry) => entry.url), [imageUrls[1]]);
  });

  it("ignores repeated and non-http URLs without counting them against the cap", () => {
    const imageUrls = [url(0), url(1), url(1), "data:image/png;base64,AAA", url(0), url(2), url(3)];
    const plan = planProductImageDownloads({ imageUrls, images: [], primaryUrl: imageUrls[0], maxImages: 3 });
    assert.deepEqual(plan.additional.map((entry) => entry.url), [url(1), url(2)]);
    assert.deepEqual(plan.additional.map((entry) => entry.index), [1, 5]);
    assert.deepEqual(plan.skippedByCap, [url(3)]);
  });
});
