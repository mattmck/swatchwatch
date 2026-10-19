import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { currentReturnTo, detailHref, returnToLabel, safeReturnTo } from "./detail-href";

// Node has no `window`; the helper reads `window.location` when it exists.
const g = globalThis as unknown as { window?: { location: Pick<Location, "pathname" | "search" | "origin"> } };

function withLocation(pathname: string, search: string) {
  g.window = { location: { pathname, search, origin: "http://localhost:3000" } };
}

afterEach(() => {
  delete g.window;
});

describe("detailHref (#348)", () => {
  it("links to the detail page with an encoded returnTo", () => {
    assert.equal(
      detailHref("42", "/polishes?status=owned&page=3"),
      "/polishes/detail?id=42&returnTo=%2Fpolishes%3Fstatus%3Downed%26page%3D3"
    );
  });

  it("encodes the id", () => {
    assert.equal(detailHref("a b&c", "/dashboard"), "/polishes/detail?id=a%20b%26c&returnTo=%2Fdashboard");
  });

  it("defaults returnTo to the current path and query", () => {
    withLocation("/polishes/gaps/", "?cell=3-2&sort=hue");
    assert.equal(
      detailHref("7"),
      "/polishes/detail?id=7&returnTo=%2Fpolishes%2Fgaps%2F%3Fcell%3D3-2%26sort%3Dhue"
    );
  });

  it("omits returnTo when there is no window (prerender) and none was given", () => {
    assert.equal(detailHref("7"), "/polishes/detail?id=7");
  });

  it("omits returnTo when explicitly null or unsafe", () => {
    withLocation("/dashboard", "");
    assert.equal(detailHref("7", null), "/polishes/detail?id=7");
    assert.equal(detailHref("7", "https://evil.example/"), "/polishes/detail?id=7");
  });

  it("round-trips through URLSearchParams back to the same returnTo", () => {
    const returnTo = "/polishes?q=50%25 off&family=red,pink&page=2";
    const href = detailHref("9", returnTo);
    const parsed = new URLSearchParams(href.split("?")[1]);
    assert.equal(parsed.get("id"), "9");
    assert.equal(safeReturnTo(parsed.get("returnTo")), returnTo);
  });
});

describe("currentReturnTo", () => {
  it("is the path plus query of the current location", () => {
    withLocation("/polishes/search/", "?hex=ff0000");
    assert.equal(currentReturnTo(), "/polishes/search/?hex=ff0000");
  });

  it("is undefined without a window", () => {
    assert.equal(currentReturnTo(), undefined);
  });
});

describe("safeReturnTo", () => {
  it("accepts same-origin relative paths with query and hash", () => {
    assert.equal(safeReturnTo("/polishes?page=3&sort=brand"), "/polishes?page=3&sort=brand");
    assert.equal(safeReturnTo("/manis"), "/manis");
    assert.equal(safeReturnTo("/polishes/gaps/#grid"), "/polishes/gaps/#grid");
  });

  it("does not decode the value a second time", () => {
    assert.equal(safeReturnTo("/polishes?q=50%25"), "/polishes?q=50%25");
  });

  it("falls back for missing values", () => {
    assert.equal(safeReturnTo(null), "/polishes");
    assert.equal(safeReturnTo(undefined), "/polishes");
    assert.equal(safeReturnTo(""), "/polishes");
  });

  it("falls back for external or protocol-relative values", () => {
    for (const value of [
      "https://evil.example/polishes",
      "//evil.example/polishes",
      "/\\evil.example",
      "\\\\evil.example",
      "javascript:alert(1)",
      "polishes",
      " /polishes",
      "/\tevil",
    ]) {
      assert.equal(safeReturnTo(value), "/polishes", value);
    }
  });

  it("uses the given fallback", () => {
    assert.equal(safeReturnTo("https://evil.example", "/dashboard"), "/dashboard");
  });
});

describe("returnToLabel", () => {
  it("names the page the back link returns to", () => {
    assert.equal(returnToLabel("/polishes?page=3"), "Collection");
    assert.equal(returnToLabel("/polishes/?status=owned"), "Collection");
    assert.equal(returnToLabel("/polishes/gaps/?cell=1-2"), "Gap Map");
    assert.equal(returnToLabel("/polishes/search?hex=ff0000"), "Color search");
    assert.equal(returnToLabel("/polishes/match"), "Photo Match");
    assert.equal(returnToLabel("/polishes/detail/?id=4&returnTo=%2Fpolishes"), "Previous polish");
    assert.equal(returnToLabel("/dashboard"), "Dashboard");
    assert.equal(returnToLabel("/manis"), "Mani Log");
    assert.equal(returnToLabel("/rapid-add/"), "Rapid Add");
  });

  it("falls back to Back for other pages", () => {
    assert.equal(returnToLabel("/admin?tab=review-queue"), "Back");
  });
});
