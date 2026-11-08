const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { diffRoster, parseSeedSources, rosterKey } = require("../dist/lib/polish-pickup-roster");

describe("polish-pickup-roster — diffRoster", () => {
  it("maps a vendor to the source named after it and leaves the rest null", () => {
    assert.deepEqual(diffRoster(["Pahlish", "Lumen"], ["PahlishShopify"]), [
      { vendor: "Pahlish", source: "PahlishShopify" },
      { vendor: "Lumen", source: null },
    ]);
  });

  it("ignores case, spaces and punctuation, and every protocol suffix", () => {
    const rows = diffRoster(
      ["Sweet & Sour Lacquer", "Bee's Knees", "Night Owl Lacquer", "Foo Feed", "Baz"],
      ["SweetAndSourLacquerShopify", "BeesKneesShopify", "NightOwlLacquerWooCommerce", "FooFeedSitemap", "BazBigCartel"]
    );
    // "&" is removed, not read as "and": only an exact alphanumeric match counts.
    assert.equal(rows[0].source, null);
    assert.equal(rows[1].source, "BeesKneesShopify");
    assert.equal(rows[2].source, "NightOwlLacquerWooCommerce");
    assert.equal(rows[3].source, "FooFeedSitemap");
    assert.equal(rows[4].source, "BazBigCartel");
  });

  it("matches metadata.brand when the name differs", () => {
    const rows = diffRoster(["Sweet & Sour Lacquer", "Roylalee"], [
      { name: "SweetAndSourLacquerShopify", brand: "Sweet & Sour Lacquer" },
      { name: "RoyLaLeeShopify" },
    ]);
    assert.equal(rows[0].source, "SweetAndSourLacquerShopify");
    assert.equal(rows[1].source, "RoyLaLeeShopify");
  });

  it("does not match a partial name", () => {
    assert.equal(diffRoster(["Pahlish Extra"], ["PahlishShopify"])[0].source, null);
    assert.equal(rosterKey("Bee's Knees"), "beesknees");
  });
});

describe("polish-pickup-roster — parseSeedSources", () => {
  it("reads names and the brand metadata of each row", () => {
    const sql = `INSERT INTO data_source (name) VALUES
  (
    'AShopify',
    'api',
    '{"brand": "A Brand", "notes": "x"}'::jsonb
  ),
  (
    'BShopify',
    'api',
    '{"notes": "none"}'::jsonb
  );`;
    assert.deepEqual(parseSeedSources(sql), [
      { name: "AShopify", brand: "A Brand" },
      { name: "BShopify", brand: null },
    ]);
  });
});
