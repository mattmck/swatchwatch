const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  protocolOf,
  isRunnableProtocol,
  materializesShadeProducts,
  protocolOfName,
  isShopifyProductsSource,
} = require("../dist/lib/connectors/registry");
const { isAutoProvisionableSource } = require("../dist/lib/ingestion-repo");
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

  it("resolves OpiSitemap (Task 15) to the sitemap protocol, never auto-provisioned", () => {
    assert.equal(protocolOf("OpiSitemap"), "SitemapJsonLd");
    assert.equal(materializesShadeProducts("OpiSitemap"), true);
    assert.equal(isShopifyProductsSource("OpiSitemap"), false);
    assert.equal(isAutoProvisionableSource("OpiSitemap"), false);
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

  it("protocol checks replace the Shopify name suffix (Task 14)", () => {
    assert.equal(protocolOfName("MooncatShopify"), "Shopify");
    assert.equal(protocolOfName("StellaChromaFeed"), "Custom");
    assert.equal(protocolOfName("toString"), "Custom");
    assert.equal(isShopifyProductsSource("MooncatShopify"), true);
    assert.equal(isShopifyProductsSource("HoloTacoShopify"), true);
    assert.equal(isShopifyProductsSource("StellaChromaFeed"), false);
    assert.equal(isShopifyProductsSource("MakeupAPI"), false);
    for (const s of SUPPORTED_SOURCES) {
      if (SOURCE_PROTOCOL_MAP[s] === "ProductFeed") assert.equal(isShopifyProductsSource(s), false, s);
    }
  });

  it("auto-provisions Shopify products.json sources only; feeds are registered by migration", () => {
    assert.equal(isAutoProvisionableSource("MooncatShopify"), true);
    assert.equal(isAutoProvisionableSource("HoloTacoShopify"), true);
    assert.equal(isAutoProvisionableSource("StellaChromaFeed"), false);
    assert.equal(isAutoProvisionableSource("OpenBeautyFacts"), false);
  });
});
