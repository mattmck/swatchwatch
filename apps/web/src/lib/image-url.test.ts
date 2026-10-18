import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSwatchThumbnailSources, buildSwatchThumbnailUrl } from "./image-url";

const PROXY = "https://api.example.com/api/images/v2.abc.def.sig";

function sizeOf(url: string): string | null {
  return new URL(url, "https://app.example").searchParams.get("w");
}

describe("buildSwatchThumbnailUrl", () => {
  it("snaps the requested size up to the pre-generated variant ladder", () => {
    assert.equal(sizeOf(buildSwatchThumbnailUrl(PROXY, 40)), "64");
    assert.equal(sizeOf(buildSwatchThumbnailUrl(PROXY, 64)), "64");
    assert.equal(sizeOf(buildSwatchThumbnailUrl(PROXY, 96)), "128");
    assert.equal(sizeOf(buildSwatchThumbnailUrl(PROXY)), "128");
    assert.equal(sizeOf(buildSwatchThumbnailUrl(PROXY, 300)), "512");
  });

  it("caps sizes above the largest variant at 512", () => {
    assert.equal(sizeOf(buildSwatchThumbnailUrl(PROXY, 2000)), "512");
  });

  it("requests a square cover WebP at the variant quality", () => {
    const url = new URL(buildSwatchThumbnailUrl(PROXY, 64));
    assert.equal(url.searchParams.get("h"), "64");
    assert.equal(url.searchParams.get("fit"), "cover");
    assert.equal(url.searchParams.get("fm"), "webp");
    assert.equal(url.searchParams.get("q"), "72");
  });

  it("handles relative proxy paths", () => {
    assert.equal(
      buildSwatchThumbnailUrl("/api/images/v2.abc", 40),
      "/api/images/v2.abc?w=64&h=64&fit=cover&fm=webp&q=72"
    );
  });

  it("leaves external URLs untouched", () => {
    assert.equal(buildSwatchThumbnailUrl("https://cdn.shop.example/p.jpg", 40), "https://cdn.shop.example/p.jpg");
    assert.equal(buildSwatchThumbnailUrl("/static/p.jpg", 40), "/static/p.jpg");
  });
});

describe("buildSwatchThumbnailSources", () => {
  it("returns a 1x src and a 2x srcSet candidate for proxied images", () => {
    const sources = buildSwatchThumbnailSources(PROXY, 40);
    assert.equal(sizeOf(sources.src), "64");
    assert.equal(sources.width, 40);
    assert.equal(sources.height, 40);
    const [x1, x2] = (sources.srcSet ?? "").split(", ");
    assert.equal(x1, `${sources.src} 1x`);
    assert.match(x2, / 2x$/);
    assert.equal(sizeOf(x2.replace(/ 2x$/, "")), "128");
  });

  it("uses the 256/512 pair for the detail-page grid", () => {
    const sources = buildSwatchThumbnailSources(PROXY, 256);
    assert.equal(sizeOf(sources.src), "256");
    assert.match(sources.srcSet ?? "", /w=512.* 2x$/);
  });

  it("omits srcSet when both densities resolve to the same variant", () => {
    const sources = buildSwatchThumbnailSources(PROXY, 400);
    assert.equal(sizeOf(sources.src), "512");
    assert.equal(sources.srcSet, undefined);
  });

  it("passes external URLs through without a srcSet", () => {
    const sources = buildSwatchThumbnailSources("https://cdn.shop.example/p.jpg", 56);
    assert.deepEqual(sources, { src: "https://cdn.shop.example/p.jpg", width: 56, height: 56 });
  });
});
