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
    false,
    '{"priority":"low","mvp":"no","notes":"Disabled 2026-10-26 (migration 20261026045216957): frozen 2015 feed with dead product/image URLs and scraped hexes."}'::jsonb
  ),
  (
    'HoloTacoShopify',
    'api',
    'https://www.holotaco.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://www.holotaco.com/pages/terms-of-service',
    true,
    '{"priority":"high","mvp":"yes","notes":"Current Holo Taco Shopify storefront pull for recent searchable shades, variant SKU/barcode, and images. Color-family tags (color:blue); no hex values."}'::jsonb
  ),
  (
    'MooncatShopify',
    'api',
    'https://www.mooncat.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    NULL,
    true,
    '{"priority":"high","mvp":"yes","notes":"Mooncat Shopify store. Rich tags with color-family (color:purple) and finish metadata; no hex values in options, titles or tags."}'::jsonb
  ),
  (
    'DamNailPolishShopify',
    'api',
    'https://damnailpolish.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    NULL,
    true,
    '{"priority":"medium","mvp":"no","notes":"Dam Nail Polish Shopify store (vendor \"Dam Nail Polish\"). Indie polish + bundles; tags include finishes (Glitter, Shimmer). Uses generic Shopify connector."}'::jsonb
  ),
  (
    'ClionadhShopify',
    'api',
    'https://clionadhcosmetics.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    NULL,
    false,
    '{"priority":"high","mvp":"yes","notes":"Clionadh Cosmetics Shopify store. Storefront is password-locked (/products.json returns 401 as of 2026-10-14); disabled."}'::jsonb
  ),
  (
    'OrlyShopify',
    'api',
    'https://orlybeauty.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    NULL,
    true,
    '{"priority":"medium","mvp":"yes","notes":"Orly Beauty Shopify store. Color names only; no hex values in options, titles or tags."}'::jsonb
  ),
  (
    'BeesKneesLacquerShopify',
    'api',
    'https://www.beeskneeslacquer.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    NULL,
    true,
    '{"priority":"medium","mvp":"yes","notes":"Bees Knees Lacquer Shopify store. Color names only; no hex values in options, titles or tags."}'::jsonb
  ),
  (
    'GreatLakesLacquerShopify',
    'api',
    'https://www.greatlakeslacquer.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    NULL,
    true,
    '{"priority":"medium","mvp":"yes","notes":"Great Lakes Lacquer Shopify store. Color names only; no hex values in options, titles or tags."}'::jsonb
  ),
  (
    'RoylaleeShopify',
    'api',
    'https://roylalee.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    NULL,
    false,
    '{"priority":"medium","mvp":"yes","notes":"Roylalee Shopify store. Lists only a gift card as of 2026-10-14; disabled."}'::jsonb
  ),
  (
    'GardenPathLacquersShopify',
    'api',
    'https://gardenpathlacquers.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    NULL,
    false,
    '{"priority":"medium","mvp":"yes","notes":"Garden Path Lacquers Shopify store. Storefront is password-locked (/products.json returns 401 as of 2026-10-14); disabled."}'::jsonb
  ),
  (
    'KathleenAndCoShopify',
    'api',
    'https://kathleenandco.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    NULL,
    true,
    '{"priority":"medium","mvp":"yes","notes":"Kathleen & Co Shopify store. Color names only; no hex values in options, titles or tags."}'::jsonb
  ),
  (
    'PrismParadeShopify',
    'api',
    'https://prismparade.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    NULL,
    true,
    '{"priority":"medium","mvp":"yes","notes":"Prism Parade Shopify store. Color names only; no hex values in options, titles or tags."}'::jsonb
  ),
  (
    'SassysaucePolishShopify',
    'api',
    'https://sassysaucepolish.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    NULL,
    true,
    '{"priority":"medium","mvp":"yes","notes":"Sassysauce Polish Shopify store. Color names only; no hex values in options, titles or tags."}'::jsonb
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
    '{"priority":"medium","mvp":"no","notes":"Le Mini Macaron Europe Shopify store. Color-family tags (Color_Pink, Color_LS_Blue); no hex values."}'::jsonb
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
    false,
    '{"priority":"medium","mvp":"no","notes":"Potion Polish store. Moved to Big Cartel (/products.json returns a bare array with name/permalink as of 2026-10-14), which the Shopify connector cannot read; disabled."}'::jsonb
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
  -- Indie Shopify sources added for #273. Registered disabled: nothing ingests until the
  -- owner approves them (roadmap 2026-10-to-12 decision 4). Verification in metadata.notes.
  -- Re-surveyed 2026-10-18 (docs/indie-sources-2026-10.md): Emily de Molly and Cirque Colors are
  -- registered below and enabled 2026-10-19 after the stores signed off (their ToS carry the clause below). Candidates checked 2026-10-17 and NOT added:
  --   Shopify default ToS "Prohibited uses ... spider, crawl, or scrape" (products.json exposed,
  --   robots.txt allows it): F.U.N Lacquer (funlacquer.com), Glam Polish (glampolish.com.au), Moon Shine Mani
  --   (moonshinemani.com). Newer template "use any robot, spider, scraping ... AI tools":
  --   Dreamland Lacquer, Ethereal Lacquer. Add only with the store's written permission.
  --   Not Shopify: ILNP (WooCommerce), Painted Polish (Big Cartel). Blocked: KBShimmer
  --   (Cloudflare challenge, 403). products.json 404/400/401: Blush Lacquers, Dimension Nails,
  --   Femme Fatale, Picture Polish, Polished for Days, Wildflower Lacquer, Leesha's Lacquer,
  --   Baroness X. MooncatShopify and CupcakePolishShopify (above) carry the same ToS clause.
  --   Batch 2, checked 2026-10-19 (docs/indie-sources-2026-10.md), NOT added: Shopify default
  --   scraping clause: Maniology, What's Up Nails. Stella Chroma, Lemming Lacquer and Sweet & Sour
  --   Lacquer carry the same clause and were added below on 2026-10-22 (batch 3, migration
  --   20261023021845964_add-approved-indie-shopify-sources) after the owner received each
  --   store's written permission by email. Copy/commercial-use clause: Nails.INC, Ninja Polish (also a multi-brand
  --   reseller). Not Shopify or unreachable: Tonic Polish, Bluebird Lacquer (401), Colores de
  --   Carol, Glisten & Glow, Masura, Killer Colors, and twenty more without a storefront answer.
  (
    'NightOwlLacquerShopify',
    'api',
    'https://nightowllacquer.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://nightowllacquer.com/policies/terms-of-service',
    true,
    '{"priority": "medium", "mvp": "no", "notes": "Night Owl Lacquer Shopify store (indie, US). Verified 2026-10-17: /products.json?limit=1 returns 200 with Shopify products; robots.txt is the Shopify default (User-agent * Allow /, products.json not disallowed; /agents.md asks server-side agents to identify via Web Bot Auth and back off on 429); /policies/terms-of-service has no terms text and /pages/policies-shipping has no automated-access clause. Catalog: product_type Polish (233 of the first 250 products pass the polish filter), vendor is the placeholder vendor-unknown on most products (the connector falls back to the brand Night Owl Lacquer), finishes in plain tags (Creme, Jelly, Crelly, Neon). Enabled 2026-10-17 by owner decision (docs/decisions-2026-10.md D2); written acceptable-use OK from the store not yet obtained.", "verification": {"checkedAt": "2026-10-17", "productsJson": true, "firstPageProducts": 250, "firstPagePolishFilterPass": 233, "robotsTxt": "shopify-default-allows-products-json", "termsScrapingClause": false}}'::jsonb
  ),
  (
    'PahlishShopify',
    'api',
    'https://pahlish.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://www.pahlish.com/policies/terms-of-service',
    true,
    '{"priority": "medium", "mvp": "no", "notes": "Pahlish Shopify store (indie, US). Verified 2026-10-17: /products.json?limit=1 returns 200 with Shopify products (36 listed: current releases only); robots.txt is the Shopify default (products.json not disallowed); /policies/terms-of-service has no terms text, no automated-access clause found. The generic connector polish filter accepts 0 of the 36 products (empty product_type, tags are collection names only); the store-specific filter connectors/store-filters/pahlish.ts (#328) accepts 28 of 36 on 2026-10-18 (single shades; gift card, collection sets, mystery batches, base/top coats and empty boxes dropped). Update 2026-10-19: acceptable use confirmed: the owner reports the store signed off on 2026-10-19 (who and how not recorded here). Enabled 2026-10-19.", "verification": {"checkedAt": "2026-10-17", "productsJson": true, "firstPageProducts": 36, "firstPagePolishFilterPass": 0, "storeFilterPass": 28, "storeFilterCheckedAt": "2026-10-18", "robotsTxt": "shopify-default-allows-products-json", "termsScrapingClause": false}}'::jsonb
  ),
  (
    'EmilyDeMollyShopify',
    'api',
    'https://emilydemolly.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://emilydemolly.com/policies/terms-of-service',
    true,
    '{"priority": "medium", "mvp": "no", "notes": "Emily de Molly Shopify store (indie, Australia). Verified 2026-10-18: /products.json returns 200 with Shopify products (317 over 2 pages: product_type Nail Polish 234, Stamping Plates 70, Stamping Polish 12, Gift Card 1); the generic connector polish filter accepts 246 (nail and stamping polishes; plates and the gift card dropped). Vendor is Emily de Molly on 313 products and EmilydeMolly on 3. robots.txt is the Shopify default (products.json not disallowed). /policies/terms-of-service is the Shopify default template, whose prohibited uses include: spider, crawl, or scrape. Update 2026-10-19: acceptable use confirmed: the owner reports the store signed off on 2026-10-19 (who and how not recorded here). Enabled 2026-10-19.", "verification": {"checkedAt": "2026-10-18", "productsJson": true, "products": 317, "polishFilterPass": 246, "robotsTxt": "shopify-default-allows-products-json", "termsScrapingClause": true}}'::jsonb
  ),
  (
    'CirqueColorsShopify',
    'api',
    'https://cirquecolors.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://www.cirquecolors.com/policies/terms-of-service',
    true,
    '{"priority": "medium", "mvp": "no", "notes": "Cirque Colors Shopify store (indie, US). Verified 2026-10-18: /products.json returns 200 with Shopify products (415 over 2 pages). product_type holds finish or line names (Retired Colors 70, Jelly 59, Magnetic 48, Sets 35, Crème 21, Nail Care 13, ...), so the generic connector polish filter accepts only 10 of 415; the store-specific filter connectors/store-filters/cirque-colors.ts (#273) accepts 328 of 415 on 2026-10-19 (single shades plus coats and cuticle oils; sets, duos, tools, charms, stickers, gift card, free gifts and creator pages dropped). robots.txt is the Shopify default (products.json not disallowed). /policies/terms-of-service is the Shopify default template, whose prohibited uses include: spider, crawl, or scrape. Update 2026-10-19: acceptable use confirmed: the owner reports the store signed off on 2026-10-19 (who and how not recorded here). Enabled 2026-10-19.", "verification": {"checkedAt": "2026-10-18", "productsJson": true, "products": 415, "polishFilterPass": 10, "storeFilterPass": 328, "storeFilterCheckedAt": "2026-10-19", "robotsTxt": "shopify-default-allows-products-json", "termsScrapingClause": true}}'::jsonb
  ),
  (
    'StellaChromaShopify',
    'api',
    'https://stellachroma.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://www.stellachroma.com/policies/terms-of-service',
    true,
    '{"priority": "medium", "mvp": "no", "notes": "Stella Chroma Shopify store (indie, US). Verified 2026-10-22: /products.json returns 200 with Shopify products (81, one page; product_type Nail Polishes 38, Nail Polish 31, Nail Care 5, Shirts 1, Gift Card 1, empty or processing 5; vendor STELLA CHROMA). The generic connector polish filter accepts 72 of 81 but keeps two collection sets, the coat duo, the mystery grab bag and the mystery subscription and drops the cuticle oil; the store-specific filter connectors/store-filters/stella-chroma.ts fixes those and accepts 68 (63 single shades, 2 top coats, 1 base coat, 2 treatments). robots.txt is the Shopify default (products.json not disallowed). /policies/terms-of-service is the Shopify default template, whose prohibited uses include: spider, crawl, or scrape. Acceptable use confirmed: written permission received by the owner by email on 2026-10-22 (recorded in docs/indie-sources-2026-10.md). Enabled 2026-10-22.", "verification": {"checkedAt": "2026-10-22", "productsJson": true, "products": 81, "polishFilterPass": 72, "storeFilterPass": 68, "storeFilterCheckedAt": "2026-10-22", "robotsTxt": "shopify-default-allows-products-json", "termsScrapingClause": true, "writtenPermission": "email 2026-10-22"}}'::jsonb
  ),
  (
    'LemmingLacquerShopify',
    'api',
    'https://lemminglacquer.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://lemminglacquer.com/policies/terms-of-service',
    true,
    '{"priority": "medium", "mvp": "no", "notes": "Lemming Lacquer Shopify store (indie, US). Verified 2026-10-22: /products.json returns 200 with Shopify products (30, one page; product_type Nail Polishes 23, Collection 3, Multichrome 1, Flakes 1, Acessories 1, empty 1). The generic connector polish filter accepts 24 of 30 but drops the Multichrome-typed shade and keeps the Polish Pickup mystery grab bag; the store-specific filter connectors/store-filters/lemming-lacquer.ts fixes both and accepts 24 single shades (collection listings, gift card, magnet and mysteries dropped). robots.txt is the Shopify default (products.json not disallowed). /policies/terms-of-service is the Shopify default template, whose prohibited uses include: spider, crawl, or scrape. Acceptable use confirmed: written permission received by the owner by email on 2026-10-22 (recorded in docs/indie-sources-2026-10.md). Enabled 2026-10-22.", "verification": {"checkedAt": "2026-10-22", "productsJson": true, "products": 30, "polishFilterPass": 24, "storeFilterPass": 24, "storeFilterCheckedAt": "2026-10-22", "robotsTxt": "shopify-default-allows-products-json", "termsScrapingClause": true, "writtenPermission": "email 2026-10-22"}}'::jsonb
  ),
  (
    'SweetAndSourLacquerShopify',
    'api',
    'https://sweetandsourlacquer.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://sweetandsourlacquer.com/policies/terms-of-service',
    true,
    '{"priority": "medium", "mvp": "no", "notes": "Sweet & Sour Lacquer Shopify store (indie, US). Verified 2026-10-22: /products.json returns 200 with Shopify products (169, one page; product_type and tags are empty on every product). The generic connector polish filter accepts 8 of 169 (coats and coat refills by title); the store-specific filter connectors/store-filters/sweet-and-sour.ts accepts 155 (150 single shades, 4 base coats, 1 top coat) by title and description, dropping the trio, duo, mystery overpour, 4 coat refills, gift card, magnet, sticker, coozies, tab opener, the clear watermarbling polish and one listing with no description beyond a restock note. robots.txt is the Shopify default (products.json not disallowed). /policies/terms-of-service is the Shopify default template, whose prohibited uses include: spider, crawl, or scrape. Acceptable use confirmed: written permission received by the owner by email on 2026-10-22 (recorded in docs/indie-sources-2026-10.md). Enabled 2026-10-22.", "verification": {"checkedAt": "2026-10-22", "productsJson": true, "products": 169, "polishFilterPass": 8, "storeFilterPass": 155, "storeFilterCheckedAt": "2026-10-22", "robotsTxt": "shopify-default-allows-products-json", "termsScrapingClause": true, "writtenPermission": "email 2026-10-22"}}'::jsonb
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
-- A reseed never changes a row that already exists in its enabled flag or its metadata keys
-- (notes, the store's recorded approval, metadata.ingestion settings): those belong to the
-- environment. Existing keys win; keys the row lacks are filled from this file. The one
-- exception is metadata.verification, the survey facts this file owns: its keys are merged
-- with this file's values winning, so a re-survey (e.g. storeFilterPass) reaches existing rows.
ON CONFLICT (name) DO UPDATE
SET
  source_type = EXCLUDED.source_type,
  base_url    = EXCLUDED.base_url,
  license     = EXCLUDED.license,
  terms_url   = EXCLUDED.terms_url,
  metadata    = EXCLUDED.metadata || COALESCE(data_source.metadata, '{}'::jsonb)
                || CASE
                     WHEN EXCLUDED.metadata ? 'verification' THEN jsonb_build_object(
                       'verification',
                       COALESCE(data_source.metadata -> 'verification', '{}'::jsonb)
                         || (EXCLUDED.metadata -> 'verification')
                     )
                     ELSE '{}'::jsonb
                   END;

COMMIT;
