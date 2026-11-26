// robots.txt Disallow-prefix reader (lib/robots.ts, brand sources plan Task 16).
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { isPathDisallowed, parseRobotsTxt } = require("../dist/lib/robots");

const STORE_API = "/wp-json/wc/store/v1/products";

describe("parseRobotsTxt", () => {
  it("groups consecutive User-agent lines and their rules, ignoring comments and other fields", () => {
    const groups = parseRobotsTxt(
      [
        "# a comment",
        "User-agent: Googlebot",
        "User-agent: Bingbot",
        "Disallow: /private/ # trailing comment",
        "Allow: /private/ok",
        "Crawl-delay: 5",
        "",
        "User-agent: *",
        "Disallow:",
        "Disallow: /wp-admin/",
        "Sitemap: https://store.example/sitemap.xml",
      ].join("\r\n")
    );
    assert.deepEqual(groups, [
      { agents: ["googlebot", "bingbot"], disallow: ["/private/"] },
      { agents: ["*"], disallow: ["/wp-admin/"] },
    ]);
  });

  it("starts a new group for a User-agent line after a rule", () => {
    const groups = parseRobotsTxt("User-agent: a\nDisallow: /x\nUser-agent: b\nDisallow: /y\n");
    assert.deepEqual(groups.map((group) => group.agents), [["a"], ["b"]]);
  });
});

describe("isPathDisallowed", () => {
  it("disallows the Store API under a * group's Disallow: /wp-json/ (ILNP's rule)", () => {
    const body = "User-agent: *\nDisallow: /wp-admin/\nDisallow: /wp-json/\nDisallow: /wc/store/v1/\n";
    assert.equal(isPathDisallowed(body, "SwatchWatch", STORE_API), true);
  });

  it("disallows on any prefix of the path, with or without a trailing slash or *", () => {
    for (const rule of ["/wp-json", "/wp-json/wc/store", "/wp-json/*", "/*/wc/store/"]) {
      assert.equal(isPathDisallowed(`User-agent: *\nDisallow: ${rule}\n`, "SwatchWatch", STORE_API), true, rule);
    }
    assert.equal(isPathDisallowed("User-agent: *\nDisallow: /wp-json/wp/v2/\n", "SwatchWatch", STORE_API), false);
    assert.equal(isPathDisallowed("User-agent: *\nDisallow: /wp-json$\n", "SwatchWatch", STORE_API), false, "$ anchors");
  });

  it("allows when robots.txt is empty, has an empty Disallow, or disallows other paths", () => {
    assert.equal(isPathDisallowed("", "SwatchWatch", STORE_API), false);
    assert.equal(isPathDisallowed("User-agent: *\nDisallow:\n", "SwatchWatch", STORE_API), false);
    assert.equal(isPathDisallowed("User-agent: *\nDisallow: /wp-admin/\nDisallow: /cart/\n", "SwatchWatch", STORE_API), false);
  });

  it("ignores groups for other named crawlers", () => {
    assert.equal(isPathDisallowed("User-agent: GPTBot\nDisallow: /\n", "SwatchWatch", STORE_API), false);
  });

  it("uses a group naming our token instead of the * groups", () => {
    const opensUs = "User-agent: *\nDisallow: /wp-json/\n\nUser-agent: SwatchWatch/1.0\nDisallow: /cart/\n";
    assert.equal(isPathDisallowed(opensUs, "SwatchWatch", STORE_API), false);
    const blocksUs = "User-agent: *\nDisallow: /cart/\n\nUser-agent: swatchwatch\nDisallow: /wp-json/\n";
    assert.equal(isPathDisallowed(blocksUs, "SwatchWatch", STORE_API), true);
  });

  it("does not read Allow: a disallowed prefix stays disallowed (no longest-match precedence)", () => {
    const body = "User-agent: *\nDisallow: /wp-json/\nAllow: /wp-json/wc/store/\n";
    assert.equal(isPathDisallowed(body, "SwatchWatch", STORE_API), true);
  });
});

describe("isPathDisallowed: glob matcher without regex backtracking (PR #506 review)", () => {
  const { isPathDisallowed: disallowed } = require("../dist/lib/robots");

  it("a rule with 30 '*'s against a 2,000-character path answers promptly", () => {
    const rule = `/${"a*".repeat(30)}b`;
    const miss = `/${"a".repeat(2000)}`;
    const hit = `/${"a".repeat(1999)}b`;
    const started = performance.now();
    assert.equal(disallowed(`User-agent: *\nDisallow: ${rule}\n`, "SwatchWatch", miss), false);
    assert.equal(disallowed(`User-agent: *\nDisallow: ${rule}\n`, "SwatchWatch", hit), true);
    assert.equal(disallowed(`User-agent: *\nDisallow: ${rule}$\n`, "SwatchWatch", `${hit}c`), false);
    assert.ok(performance.now() - started < 50, `took ${performance.now() - started} ms`);
  });

  it("keeps '*' and '$' semantics", () => {
    const body = "User-agent: *\nDisallow: /*.pdf$\nDisallow: /private*/x\nDisallow: /exact$\n";
    assert.equal(disallowed(body, "SwatchWatch", "/docs/a.pdf"), true);
    assert.equal(disallowed(body, "SwatchWatch", "/docs/a.pdf?x=1"), false);
    assert.equal(disallowed(body, "SwatchWatch", "/private-area/x/y"), true);
    assert.equal(disallowed(body, "SwatchWatch", "/privatex"), false);
    assert.equal(disallowed(body, "SwatchWatch", "/exact"), true);
    assert.equal(disallowed(body, "SwatchWatch", "/exact/more"), false);
    assert.equal(disallowed("User-agent: *\nDisallow: /a.b\n", "SwatchWatch", "/aXb"), false, "'.' is literal");
  });
});
