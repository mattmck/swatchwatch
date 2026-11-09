const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  protocolOf,
  isRunnableProtocol,
  materializesShadeProducts,
} = require("../dist/lib/connectors/registry");
const { SOURCE_PROTOCOL_MAP, SUPPORTED_SOURCES } = require("../dist/lib/connectors/generated-types");

describe("connector registry", () => {
  it("maps suffixes to protocols", () => {
    assert.equal(protocolOf("MooncatShopify"), "Shopify");
    assert.equal(protocolOf("HoloTacoShopify"), "HoloTaco");
    assert.equal(protocolOf("OpenBeautyFacts"), "OpenBeautyFacts");
    assert.equal(protocolOf("MakeupAPI"), "MakeupAPI");
    assert.equal(protocolOf("CosIng"), "GS1");
    assert.equal(protocolOf("UserCapture"), "Custom");
  });

  it("resolves the brand-store sources (Task 10) to the Shopify protocol", () => {
    for (const name of [
      "DeborahLippmannShopify", "LondontownShopify", "CoteShopify", "ManucuristShopify",
      "OliveAndJuneShopify", "PiggyPaintShopify", "MavalaShopify", "WetNWildShopify",
      "AlchemyLacquersShopify", "PenelopeLuzShopify", "NoodlesNailPolishShopify",
      "CndShopify", "BarryMShopify",
    ]) {
      assert.equal(protocolOf(name), "Shopify", name);
      assert.equal(materializesShadeProducts(name), true, name);
    }
  });

  it("resolves the pending clause stores (Task 12) to the Shopify protocol", () => {
    for (const name of [
      "DazzleDryShopify", "SundaysShopify", "JinsoonShopify", "TenovertenShopify", "NailberryShopify",
      "DndShopify", "GlamPolishShopify", "NailHootShopify", "MoonShineManiShopify", "FunLacquerShopify",
      "AnchorAndHeartShopify", "ButterLondonShopify", "EllaMilaShopify", "KiaraSkyShopify",
      "StaticNailsShopify", "PacificaShopify", "RevlonShopify", "ModelonesShopify",
      "DreamlandLacquerShopify", "EtherealLacquerShopify",
    ]) {
      assert.equal(protocolOf(name), "Shopify", name);
      assert.equal(materializesShadeProducts(name), true, name);
    }
  });

  it("lists the runnable protocols", () => {
    for (const protocol of [
      "HoloTaco",
      "Shopify",
      "OpenBeautyFacts",
      "MakeupAPI",
      "ProductFeed",
      "SitemapJsonLd",
      "WooCommerce",
      "BigCartel",
    ]) {
      assert.equal(isRunnableProtocol(protocol), true, protocol);
    }
    assert.equal(isRunnableProtocol("GS1"), false);
    assert.equal(isRunnableProtocol("Custom"), false);
  });

  it("only shade-product protocols materialize", () => {
    assert.equal(materializesShadeProducts("MooncatShopify"), true);
    assert.equal(materializesShadeProducts("HoloTacoShopify"), true);
    assert.equal(materializesShadeProducts("OpenBeautyFacts"), false);
    assert.equal(materializesShadeProducts("MakeupAPI"), false);
    assert.equal(materializesShadeProducts("CosIng"), false);
    assert.equal(materializesShadeProducts("UserCapture"), false);
  });

  it("the generator and the registry agree on every supported source", () => {
    assert.ok(SUPPORTED_SOURCES.length > 0);
    for (const s of SUPPORTED_SOURCES) assert.equal(protocolOf(s), SOURCE_PROTOCOL_MAP[s]);
  });
});
