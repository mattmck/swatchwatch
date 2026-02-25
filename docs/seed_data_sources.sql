-- seed_data_sources_v1_1.sql
-- Idempotent seed data for easiest external/internal sources used by the MVP.
-- Target DB: PostgreSQL (uses ON CONFLICT DO UPDATE)

BEGIN;

INSERT INTO data_source (name, source_type, base_url, license, terms_url, enabled, metadata)
VALUES
  (
    'ManualEntry',
    'manual',
    NULL,
    NULL,
    NULL,
    true,
    '{"priority":"high","mvp":"yes","notes":"Admin/user manual edits and corrections. Always allowed; provenance used for audit."}'::jsonb
  ),
  (
    'UserCapture',
    'api',
    NULL,
    NULL,
    NULL,
    true,
    '{"priority":"highest","mvp":"yes","notes":"Your app-generated evidence: barcode frames, label photos, swatches. Private-by-default; opt-in sharing supported."}'::jsonb
  ),
  (
    'OpenBeautyFacts',
    'api',
    'https://world.openbeautyfacts.org',
    'Open Database License (ODbL) (verify obligations)',
    'https://world.openbeautyfacts.org/terms-of-use',
    true,
    '{"priority":"high","mvp":"yes","notes":"Barcode-first bootstrap for product name/brand and sometimes ingredients/labels. Coverage varies; cache by GTIN."}'::jsonb
  ),
  (
    'MakeupAPI',
    'api',
    'https://makeup-api.herokuapp.com',
    'Public API (verify terms)',
    'https://makeup-api.herokuapp.com',
    true,
    '{"priority":"medium","mvp":"yes","notes":"One-time bootstrap for nail polish brand/shade and hex color variants."}'::jsonb
  ),
  (
    'HoloTacoShopify',
    'api',
    'https://www.holotaco.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://www.holotaco.com/pages/terms-of-service',
    true,
    '{"priority":"high","mvp":"yes","notes":"Current Holo Taco Shopify storefront pull for recent searchable shades, variant SKU/barcode, and images."}'::jsonb
  ),
  (
    'MooncatShopify',
    'api',
    'https://www.mooncat.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    NULL,
    true,
    '{"priority":"high","mvp":"yes","notes":"Mooncat Shopify store. Rich tags with color/finish metadata. Hex extraction from option values."}'::jsonb
  ),
  (
    'ClionadhShopify',
    'api',
    'https://clionadhcosmetics.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    NULL,
    true,
    '{"priority":"high","mvp":"yes","notes":"Clionadh Cosmetics Shopify store. Rich tags (Jelly, Scattered Holo, Thermal, color:periwinkle)."}'::jsonb
  ),
  (
    'OrlyShopify',
    'api',
    'https://orlybeauty.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    NULL,
    true,
    '{"priority":"medium","mvp":"yes","notes":"Orly Beauty Shopify store. Hex colors in variant option values."}'::jsonb
  ),
  (
    'BeesKneesLacquerShopify',
    'api',
    'https://www.beeskneeslacquer.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    NULL,
    true,
    '{"priority":"medium","mvp":"yes","notes":"Bees Knees Lacquer Shopify store. Hex colors in variant option values."}'::jsonb
  ),
  (
    'GreatLakesLacquerShopify',
    'api',
    'https://www.greatlakeslacquer.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    NULL,
    true,
    '{"priority":"medium","mvp":"yes","notes":"Great Lakes Lacquer Shopify store. Hex colors in variant option values."}'::jsonb
  ),
  (
    'RoylaleeShopify',
    'api',
    'https://roylalee.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    NULL,
    true,
    '{"priority":"medium","mvp":"yes","notes":"Roylalee Shopify store. Hex colors in variant option values."}'::jsonb
  ),
  (
    'GardenPathLacquersShopify',
    'api',
    'https://gardenpathlacquers.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    NULL,
    true,
    '{"priority":"medium","mvp":"yes","notes":"Garden Path Lacquers Shopify store. Hex colors in variant option values."}'::jsonb
  ),
  (
    'KathleenAndCoShopify',
    'api',
    'https://kathleenandco.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    NULL,
    true,
    '{"priority":"medium","mvp":"yes","notes":"Kathleen & Co Shopify store. Hex colors in variant option values."}'::jsonb
  ),
  (
    'PrismParadeShopify',
    'api',
    'https://prismparade.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    NULL,
    true,
    '{"priority":"medium","mvp":"yes","notes":"Prism Parade Shopify store. Hex colors in variant option values."}'::jsonb
  ),
  (
    'SassysaucePolishShopify',
    'api',
    'https://sassysaucepolish.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    NULL,
    true,
    '{"priority":"medium","mvp":"yes","notes":"Sassysauce Polish Shopify store. Some hex in option values."}'::jsonb
  ),
  (
    'ColorClubShopify',
    'api',
    'https://colorclub.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    NULL,
    true,
    '{"priority":"medium","mvp":"no","notes":"Color Club Shopify store. Color names only, no hex values."}'::jsonb
  ),
  (
    'RogueLacquerShopify',
    'api',
    'https://roguelacquer.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    NULL,
    true,
    '{"priority":"medium","mvp":"no","notes":"Rogue Lacquer Shopify store. Color names only."}'::jsonb
  ),
  (
    'RedEyedLacquerShopify',
    'api',
    'https://redeyedlacquer.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    NULL,
    true,
    '{"priority":"medium","mvp":"no","notes":"Red Eyed Lacquer Shopify store. Color names only."}'::jsonb
  ),
  (
    'CupcakePolishShopify',
    'api',
    'https://www.cupcakepolish.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    NULL,
    true,
    '{"priority":"medium","mvp":"no","notes":"Cupcake Polish Shopify store. Color names only."}'::jsonb
  ),
  (
    'LoudBabbsShopify',
    'api',
    'https://loudbabbs.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    NULL,
    true,
    '{"priority":"medium","mvp":"no","notes":"Loud Babbs Shopify store. Color names only."}'::jsonb
  ),
  (
    'PaintItPrettyPolishShopify',
    'api',
    'https://paintitprettypolish.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    NULL,
    true,
    '{"priority":"medium","mvp":"no","notes":"Paint It Pretty Polish Shopify store. Color names only."}'::jsonb
  ),
  (
    'ChinaGlazeShopify',
    'api',
    'https://chinaglaze.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    NULL,
    true,
    '{"priority":"medium","mvp":"no","notes":"China Glaze Shopify store. Color names in options."}'::jsonb
  ),
  (
    'LeMiniMacaronShopify',
    'api',
    'https://www.leminimacaron.eu',
    'Storefront terms apply (verify metadata/image usage obligations)',
    NULL,
    true,
    '{"priority":"medium","mvp":"no","notes":"Le Mini Macaron Europe Shopify store. Some color tags (Color_LS_*)."}'::jsonb
  ),
  (
    'CrackedPolishShopify',
    'api',
    'https://crackedpolish.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    NULL,
    true,
    '{"priority":"medium","mvp":"no","notes":"Cracked Polish Shopify store."}'::jsonb
  ),
  (
    'OliveAvePolishShopify',
    'api',
    'https://oliveavepolish.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    NULL,
    true,
    '{"priority":"medium","mvp":"no","notes":"Olive Ave Polish Shopify store."}'::jsonb
  ),
  (
    'LightsLacquerShopify',
    'api',
    'https://lightslacquer.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    NULL,
    true,
    '{"priority":"medium","mvp":"no","notes":"Lights Lacquer Shopify store."}'::jsonb
  ),
  (
    'ZombieClawPolishShopify',
    'api',
    'https://zombieclawpolish.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    NULL,
    true,
    '{"priority":"medium","mvp":"no","notes":"Zombie Claw Polish Shopify store."}'::jsonb
  ),
  (
    'PotionPolishShopify',
    'api',
    'https://www.potionpolish.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    NULL,
    true,
    '{"priority":"medium","mvp":"no","notes":"Potion Polish Shopify store."}'::jsonb
  ),
  (
    'StarrilyShopify',
    'api',
    'https://www.starrily.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    NULL,
    true,
    '{"priority":"medium","mvp":"no","notes":"Starrily Shopify store."}'::jsonb
  ),
  (
    'TylerStrinketsShopify',
    'api',
    'https://tylerstrinkets.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    NULL,
    true,
    '{"priority":"medium","mvp":"no","notes":"Tyler Strinkets Shopify store."}'::jsonb
  ),
  (
    'DrunkFairyPolishShopify',
    'api',
    'https://drunkfairypolish.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    NULL,
    true,
    '{"priority":"medium","mvp":"no","notes":"Drunk Fairy Polish Shopify store."}'::jsonb
  ),
  (
    'CosIng',
    'api',
    'https://ec.europa.eu/growth/sectors/cosmetics/cosing',
    'EU reference database (verify reuse terms)',
    'https://single-market-economy.ec.europa.eu/sectors/cosmetics/cosmetic-ingredient-database_en',
    true,
    '{"priority":"medium","mvp":"yes","notes":"Ingredient ontology/normalization (INCI names, functions). Not a product catalog."}'::jsonb
  ),
  (
    'ImpactAffiliateNetwork',
    'api',
    'https://impact.com',
    'Affiliate program terms per retailer/network',
    'https://impact.com/partner',
    true,
    '{"priority":"high","mvp":"yes","notes":"Retail deeplinks and (when available) product feeds. Use click-required outbound links + disclosure."}'::jsonb
  ),
  (
    'RakutenAdvertising',
    'api',
    'https://rakutenadvertising.com',
    'Affiliate program terms per retailer/network',
    'https://developers.rakutenadvertising.com',
    true,
    '{"priority":"high","mvp":"yes","notes":"Retail deeplinks and reporting via Rakuten Advertising. Avoid scraping; prefer official APIs/feeds."}'::jsonb
  ),
  (
    'GS1Lookup',
    'api',
    'https://www.gs1.org',
    'May be paid/limited (verify access level)',
    'https://www.gs1.org/services/verified-by-gs1',
    false,
    '{"priority":"low","mvp":"no","notes":"Optional GTIN validation / brand owner enrichment. Enable only if you have access and it is cost-effective."}'::jsonb
  ),
  (
    'openFDA_CosmeticEvents',
    'api',
    'https://open.fda.gov/apis/cosmetic/event/',
    'Public API (verify terms)',
    'https://open.fda.gov/apis/',
    false,
    '{"priority":"low","mvp":"no","notes":"Optional later: adverse event signals, not ingredients. Use careful UX and disclaimers."}'::jsonb
  )
ON CONFLICT (name) DO UPDATE
SET
  source_type = EXCLUDED.source_type,
  base_url    = EXCLUDED.base_url,
  license     = EXCLUDED.license,
  terms_url   = EXCLUDED.terms_url,
  enabled     = EXCLUDED.enabled,
  metadata    = EXCLUDED.metadata;

COMMIT;
