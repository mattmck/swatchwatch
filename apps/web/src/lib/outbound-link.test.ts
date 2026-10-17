import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { outboundLinkProps, safeOutboundUrl } from "./outbound-link";

describe("safeOutboundUrl", () => {
  it("accepts absolute http(s) URLs", () => {
    assert.equal(safeOutboundUrl("https://www.holotaco.com/products/blurple"), "https://www.holotaco.com/products/blurple");
    assert.equal(safeOutboundUrl("http://shop.example/p"), "http://shop.example/p");
  });

  for (const value of [
    "javascript:alert(1)",
    " JAVASCRIPT:alert(1)",
    "java\nscript:alert(1)",
    "data:text/html,hi",
    "/products/blurple",
    "//evil.example/",
    "https:evil.example",
    "https://user:pw@evil.example/",
    "https://user@evil.example/",
    "",
    undefined,
    null,
    42,
  ]) {
    it(`rejects ${JSON.stringify(value)}`, () => {
      assert.equal(safeOutboundUrl(value), null);
    });
  }
});

describe("outboundLinkProps", () => {
  it("opens safe links in a new tab without opener, referrer or endorsement", () => {
    assert.deepEqual(outboundLinkProps("https://brand.example/p"), {
      href: "https://brand.example/p",
      target: "_blank",
      rel: "noopener noreferrer nofollow",
    });
  });

  it("returns null for unsafe or missing URLs so no link renders", () => {
    assert.equal(outboundLinkProps("javascript:alert(1)"), null);
    assert.equal(outboundLinkProps(undefined), null);
  });
});
