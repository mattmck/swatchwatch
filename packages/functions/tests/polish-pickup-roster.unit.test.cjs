const fs = require("node:fs");
const path = require("node:path");
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
    // "&" reads as "and".
    assert.equal(rows[0].source, "SweetAndSourLacquerShopify");
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

  it("reads + as nothing and ignores a trailing Lacquer / Polish word on the source side", () => {
    const rows = diffRoster(["ella+mila", "Bee's Knees", "Zombie Claw", "Dam Nail Polish"], [
      "EllaMilaShopify",
      "BeesKneesLacquerShopify",
      "ZombieClawPolishShopify",
      "DamNailPolishShopify",
    ]);
    assert.deepEqual(rows.map((row) => row.source), [
      "EllaMilaShopify",
      "BeesKneesLacquerShopify",
      "ZombieClawPolishShopify",
      "DamNailPolishShopify",
    ]);
    // An exact match wins over a prefix match, and an unrelated longer name does not match.
    assert.equal(diffRoster(["Pahlish"], ["PahlishExtraShopify", "PahlishShopify"])[0].source, "PahlishShopify");
    assert.equal(diffRoster(["Pahlish"], ["PahlishExtraShopify"])[0].source, null);
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

describe("polish-pickup-roster — the real seed", () => {
  const sources = parseSeedSources(fs.readFileSync(path.resolve(__dirname, "../../../docs/seed_data_sources.sql"), "utf8"));

  it("finds the registered sources", () => {
    assert.ok(sources.length > 70);
    assert.ok(sources.some((source) => source.name === "KathleenAndCoShopify"));
  });

  it("maps the Polish Pickup vendors spelled differently from their source", () => {
    const vendors = ["Sweet & Sour Lacquer", "Kathleen & Co", "Bee's Knees", "Zombie Claw", "Dam Nail Polish", "Sassy Sauce Polish", "Lumen"];
    assert.deepEqual(diffRoster(vendors, sources).map((row) => row.source), [
      "SweetAndSourLacquerShopify",
      "KathleenAndCoShopify",
      "BeesKneesLacquerShopify",
      "ZombieClawPolishShopify",
      "DamNailPolishShopify",
      "SassysaucePolishShopify",
      null,
    ]);
  });
});
