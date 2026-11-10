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
    '{"priority":"medium","mvp":"no","notes":"Potion Polish store. Moved to Big Cartel (/products.json returns a bare array with name/permalink as of 2026-10-14), which the Shopify connector cannot read; disabled. Superseded by PotionPolishBigCartel."}'::jsonb
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
  --   retailer). Not Shopify or unreachable: Tonic Polish, Bluebird Lacquer (401), Colores de
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
    'PolishPickupShopify',
    'api',
    'https://polishpickup.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://polishpickup.com/policies/terms-of-service',
    false,
    '{"kind": "retailer", "currency": "USD", "priority": "medium", "mvp": "no", "pendingApproval": true, "notes": "Polish Pickup: monthly multi-brand indie pre-order shop. Pending owner OK."}'::jsonb
  ),
  (
    'HarlowAndCoShopify',
    'api',
    'https://www.harlowandco.org',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://www.harlowandco.org/policies/terms-of-service',
    true,
    '{"kind": "retailer", "currency": "CAD", "vendorAliases": {"Cirque": "Cirque Colors", "piCture pOlish": "Picture Polish"}, "priority": "medium", "mvp": "no", "notes": "Harlow & Co Shopify store (Canadian multi-brand retailer, CAD). Verified 2026-11-08: /products.json returns 200 with Shopify products (1,537 over 7 pages, 22 vendors). Polish is typed Nail Polish / Nail Polishes (ILNP 605, KBShimmer 260, Cirque 238, Color Club, Polished for Days, Emily de Molly, I Scream Nails); the rest is other vendors'' decals, stamping plates, scrubs, oils, lotions, magnets and apparel. The store-specific filter connectors/store-filters/harlow-and-co.ts drops the non-polish product types and vendors and set-titled listings; with the retailer gate expected about 1,282 of 1,537 (from the 2026-11-08 pull; the first dry run confirms). robots.txt is the Shopify default (products.json not disallowed). The store''s own terms carry no automated-access clause. Registered as a retailer (metadata.kind = retailer): listings adopt the brand stores'' shades and only fill empty data; images stay off until metadata.imagesPermitted is set after the store''s OK. Enabled 2026-11-08.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "products": 1537, "vendors": 22, "storeFilterPass": 1282, "storeFilterCheckedAt": "2026-11-08", "robotsTxt": "shopify-default-allows-products-json", "termsScrapingClause": false}}'::jsonb
  ),
  (
    'BeyondPolishShopify',
    'api',
    'https://www.beyondpolish.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://www.beyondpolish.com/policies/terms-of-service',
    true,
    '{"kind": "retailer", "currency": "USD", "includeGel": false, "maxPages": 100, "vendorAliases": {"ORLY": "Orly", "Lippmann": "Deborah Lippmann", "Sunday Studio": "Sundays", "DND - Daisy Nail Design": "DND", "Harmony": "Gelish", "ella+mila": "Ella+Mila", "butter LONDON": "butter LONDON"}, "priority": "medium", "mvp": "no", "notes": "Beyond Polish Shopify store (US multi-brand retailer, USD). Verified 2026-11-08: /products.json returns 200 with Shopify products (17,508 over 71 pages of 250, 103 vendors). The store''s own terms carry no automated-access clause (only a sentence about harvesting other users'' personal data); robots.txt is the Shopify default (products.json not disallowed). The generic polish gate accepts 9,395 of the 17,508; the lacquer-typed products (product_type Nail Lacquer, Lacquer & Dip, Gel, Lacquer & Dip) accept 4,138 (OPI 1,160, Zoya 262, Orly 255, Cirque 244, KBShimmer 223, Morgan Taylor 205, CND 159, Ella+Mila 142, Londontown 141, Essie 118, China Glaze 102, Color Club 80, butter LONDON 66). The store-specific filter connectors/store-filters/beyond-polish.ts keeps only those lacquer types (Gel Polish too when metadata.includeGel is true) and drops Gel & Lacquer Polish combos, sets, kits, mystery boxes, hair, skin, jewellery, tools and the store''s own merchandise. Products.json carries no barcodes. Registered as a retailer (metadata.kind = retailer): listings adopt the brand stores'' shades and only fill empty data; images stay off until metadata.imagesPermitted is set after the store''s OK. maxPages 100 lets the 71-page catalog be read to the end. Enabled 2026-11-08.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "products": 17508, "vendors": 103, "genericGateAccepts": 9395, "lacquerTypedAccepts": 4138, "barcodesInProductsJson": false, "robotsTxt": "shopify-default-allows-products-json", "termsScrapingClause": false}}'::jsonb
  ),
  (
    'HypnoticPolishShopify',
    'api',
    'https://www.hypnoticpolish.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://www.hypnoticpolish.com/policies/terms-of-service',
    false,
    '{"kind": "retailer", "currency": "EUR", "vendorAliases": {"Cuticula Nail Lacquer": "Cuticula"}, "pendingApproval": true, "priority": "medium", "mvp": "no", "notes": "Hypnotic Polish Shopify store (EU multi-brand retailer, EUR). Verified 2026-11-08: /products.json returns 200 with Shopify products (998 over 4 pages of 250, 16 vendors). robots.txt is the Shopify default (products.json not disallowed). /policies/terms-of-service carries the Shopify default template, whose prohibited uses include: spider, crawl, or scrape. REGISTERED DISABLED AND PENDING: needs the store''s written OK before it is enabled; record it here as ''Acceptable use confirmed by <name, role> at Hypnotic Polish on <date> via <channel>: <summary>'', then set enabled = true and remove pendingApproval. The generic polish gate accepts 977 of the 998; headline brands (accepted listings): ILNP 308, Cirque Colors 201, KBShimmer 110, Cosmic Polish 73, Cuticula 68, Emily de Molly 58, Bee''s Knees 49, Starrily 49, Cadillacquer 40. The store filter connectors/store-filters/hypnotic-polish.ts drops the Cuticle Treatment and Accessories product types and grab bag / mystery listings; coats and toppers go through the generic gate with their category. Registered as a retailer (metadata.kind = retailer): listings adopt the brand stores'' shades and only fill empty data; vendorAliases map the store''s vendor spellings to brands; images stay off until metadata.imagesPermitted is set after the store''s OK.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "products": 998, "vendors": 16, "genericGateAccepts": 977, "robotsTxt": "shopify-default-allows-products-json", "termsScrapingClause": true, "writtenPermission": null}}'::jsonb
  ),
  (
    'DeborahLippmannShopify',
    'api',
    'https://deborahlippmann.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://deborahlippmann.com/policies/terms-of-service',
    true,
    '{"currency": "USD", "priority": "medium", "mvp": "no", "notes": "Deborah Lippmann Shopify store (US, USD). Verified 2026-11-08: /products.json returns 200 with Shopify products (54: Nail Polish 25, Set 14, Treatment 7, Tools 5). The generic connector polish filter applies unchanged; sets are dropped by the set rule. Terms (6,300 characters) carry no automated-access clause. robots.txt does not disallow products.json. Registered as a brand store (no metadata.kind). Enabled 2026-11-08 under decision D2 (no automated-access clause); the store''s written OK has not been requested.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "products": 54, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": false}}'::jsonb
  ),
  (
    'LondontownShopify',
    'api',
    'https://londontownusa.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://londontownusa.com/policies/terms-of-service',
    true,
    '{"currency": "USD", "priority": "medium", "mvp": "no", "notes": "Londontown Shopify store (US, USD). Verified 2026-11-08: /products.json returns 200 with Shopify products (250+ over several pages; first page: Nail Color 68, Gels 65, Sets 39, Nail Care 30, Tools 27). Store filter connectors/store-filters/londontown.ts keeps Nail Color (and Nail Veils / Concealers), drops gels (unless includeGel), sets and the other non-polish types, and defers Nail Care to the generic gate, which keeps its coats and treatments with their category. Terms carry no automated-access clause. robots.txt does not disallow products.json. Registered as a brand store (no metadata.kind). Enabled 2026-11-08 under decision D2 (no automated-access clause); the store''s written OK has not been requested.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "firstPageProducts": 250, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": false}}'::jsonb
  ),
  (
    'CoteShopify',
    'api',
    'https://coteshop.co',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://coteshop.co/policies/terms-of-service',
    true,
    '{"currency": "USD", "vendorAliases": {"Côte Beauty": "Côte"}, "priority": "medium", "mvp": "no", "notes": "Cote Shopify store (US, USD). Verified 2026-11-08: /products.json returns 200 with Shopify products (129: Nail Polishes 66, gift set 11, lip shine 9, treatment 8, body 8). The generic gate handles the page except for the lip treatment it reads as a nail treatment; the store filter connectors/store-filters/cote.ts drops lip-typed products and defers the rest to it. Vendor Côte Beauty is aliased to the catalog brand Côte. Terms carry no automated-access clause. robots.txt does not disallow products.json. Registered as a brand store (no metadata.kind). Enabled 2026-11-08 under decision D2 (no automated-access clause); the store''s written OK has not been requested.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "products": 129, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": false}}'::jsonb
  ),
  (
    'ManucuristShopify',
    'api',
    'https://manucurist.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://manucurist.com/policies/terms-of-service',
    true,
    '{"currency": "EUR", "priority": "medium", "mvp": "no", "notes": "Manucurist Shopify store (France, EUR). Verified 2026-11-08: /products.json returns 200 with Shopify products (250+; first page: product_type Vernis a ongles Green 68, Semi-permanent LED Green Flash 59, Soins 36, French product_type values). Store filter connectors/store-filters/manucurist.ts maps the French types. Terms carry no automated-access clause. robots.txt does not disallow products.json. Registered as a brand store (no metadata.kind). Enabled 2026-11-08 under decision D2 (no automated-access clause); the store''s written OK has not been requested.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "firstPageProducts": 250, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": false}}'::jsonb
  ),
  (
    'OliveAndJuneShopify',
    'api',
    'https://oliveandjune.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://oliveandjune.com/policies/terms-of-service',
    true,
    '{"currency": "USD", "vendorAliases": {"Olive and June": "Olive & June", "Olive-and-June": "Olive & June", "Olive & June Gel": "Olive & June"}, "priority": "medium", "mvp": "no", "notes": "Olive & June Shopify store (US, USD). Verified 2026-11-08: /products.json returns 200 with Shopify products (250+; first page: Press-On 51, Tab Press-On 30, Nail Polish 28, Pressies 22, Gel Polish 20, Dip). Store filter connectors/store-filters/olive-and-june.ts keeps Nail Polish and drops press-ons, gel and dip. Terms carry no automated-access clause. robots.txt does not disallow products.json. Registered as a brand store (no metadata.kind). Enabled 2026-11-08 under decision D2 (no automated-access clause); the store''s written OK has not been requested.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "firstPageProducts": 250, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": false}}'::jsonb
  ),
  (
    'PiggyPaintShopify',
    'api',
    'https://piggypaint.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://piggypaint.com/policies/terms-of-service',
    true,
    '{"currency": "USD", "priority": "medium", "mvp": "no", "notes": "Piggy Paint Shopify store (US, USD). Verified 2026-11-08: /products.json returns 200 with Shopify products (250+; first page: empty product_type 110, Nail Art Kits & Accessories 92, Nail Polishes 24, Wholesale 12). Store filter connectors/store-filters/piggy-paint.ts handles the empty types. Terms carry no automated-access clause. robots.txt does not disallow products.json. Registered as a brand store (no metadata.kind). Enabled 2026-11-08 under decision D2 (no automated-access clause); the store''s written OK has not been requested.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "firstPageProducts": 250, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": false}}'::jsonb
  ),
  (
    'MavalaShopify',
    'api',
    'https://mavala.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://mavala.com/policies/terms-of-service',
    false,
    '{"currency": "CHF", "priority": "medium", "mvp": "no", "pendingApproval": true, "notes": "Mavala Shopify store (Switzerland, CHF). Verified 2026-11-08: /products.json returns 200 with Shopify products (150: Nail Care 34, Skincare 27, Make-Up 26, Instruments 19, Nail Polish 19). The generic connector polish filter applies unchanged. The terms page answered HTTP 500 on 2026-11-08, so the terms are unknown. robots.txt does not disallow products.json. REGISTERED DISABLED AND PENDING: the terms page answered HTTP 500, so whether automated access is allowed is unknown. The owner reads the site terms (or gets the store''s written OK) and records it here as ''Acceptable use confirmed by <name, role> at Mavala on <date> via <channel>: <summary>'', then sets enabled = true and removes pendingApproval.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "products": 150, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": null}}'::jsonb
  ),
  (
    'WetNWildShopify',
    'api',
    'https://wetnwildbeauty.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://wetnwildbeauty.com/policies/terms-of-service',
    true,
    '{"currency": "USD", "vendorAliases": {"Markwins WNW": "Wet n Wild", "wet n wild Beauty": "Wet n Wild"}, "priority": "medium", "mvp": "no", "notes": "wet n wild Shopify store (US, USD). Verified 2026-11-08: /products.json returns 200 with Shopify products (250+ cosmetics; polish is not on page 1). Store filter connectors/store-filters/wet-n-wild.ts keeps title/type Nail Color. Terms carry no automated-access clause. robots.txt does not disallow products.json. Registered as a brand store (no metadata.kind). Enabled 2026-11-08 under decision D2 (no automated-access clause); the store''s written OK has not been requested.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "firstPageProducts": 250, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": false}}'::jsonb
  ),
  (
    'AlchemyLacquersShopify',
    'api',
    'https://alchemylacquers.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://alchemylacquers.com/policies/terms-of-service',
    true,
    '{"currency": "USD", "vendorAliases": {"My Store": "Alchemy Lacquers"}, "priority": "medium", "mvp": "no", "notes": "Alchemy Lacquers Shopify store (US indie, USD). Verified 2026-11-08: /products.json returns 200 with Shopify products (228: Nail Lacquer 198, empty product_type 30). The generic gate handles the page except for blind listings (Mystery Overpours); the store filter connectors/store-filters/alchemy-lacquers.ts drops mystery, grab bag, sample and pick-N listings and defers the rest to it. Vendor My Store (12 coats and toppers) is aliased to Alchemy Lacquers. Terms (2,100 characters) carry no automated-access clause. robots.txt does not disallow products.json. Registered as a brand store (no metadata.kind). Enabled 2026-11-08 under decision D2 (no automated-access clause); the store''s written OK has not been requested.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "products": 228, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": false}}'::jsonb
  ),
  (
    'PenelopeLuzShopify',
    'api',
    'https://penelopeluz.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://penelopeluz.com/policies/terms-of-service',
    true,
    '{"currency": "USD", "priority": "medium", "mvp": "no", "notes": "Penelope Luz Shopify store (US indie, USD). Verified 2026-11-08: /products.json returns 200 with Shopify products (216; product_type is empty on all). Store filter connectors/store-filters/penelope-luz.ts (title blocklist + description check). Terms (2,000 characters) carry no automated-access clause. robots.txt does not disallow products.json. Registered as a brand store (no metadata.kind). Enabled 2026-11-08 under decision D2 (no automated-access clause); the store''s written OK has not been requested.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "products": 216, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": false}}'::jsonb
  ),
  (
    'NoodlesNailPolishShopify',
    'api',
    'https://noodlesnailpolish.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://noodlesnailpolish.com/policies/terms-of-service',
    true,
    '{"currency": "USD", "priority": "medium", "mvp": "no", "notes": "Noodles Nail Polish Shopify store (US indie, USD). Verified 2026-11-08: /products.json returns 200 with Shopify products (57; product_type is empty). Store filter connectors/store-filters/noodles.ts (title blocklist + description check). Terms (600 characters) carry no automated-access clause. robots.txt does not disallow products.json. Registered as a brand store (no metadata.kind). Enabled 2026-11-08 under decision D2 (no automated-access clause); the store''s written OK has not been requested.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "products": 57, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": false}}'::jsonb
  ),
  (
    'CndShopify',
    'api',
    'https://cnd.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://cnd.com/policies/terms-of-service',
    false,
    '{"currency": "USD", "priority": "medium", "mvp": "no", "pendingApproval": true, "notes": "CND Shopify store (US, Vinylux and Shellac, USD). Verified 2026-11-08: /products.json returns 200 with Shopify products (117: empty product_type 111, Gel Polish 6). Store filter connectors/store-filters/cnd.ts handles the empty types. There is no terms page at /policies/terms-of-service (404). robots.txt does not disallow products.json. REGISTERED DISABLED AND PENDING: there is no terms page at the Shopify path, so whether automated access is allowed is unknown. The owner reads the site terms (or gets the store''s written OK) and records it here as ''Acceptable use confirmed by <name, role> at CND on <date> via <channel>: <summary>'', then sets enabled = true and removes pendingApproval.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "products": 117, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": null}}'::jsonb
  ),
  (
    'BarryMShopify',
    'api',
    'https://barrym.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://barrym.com/policies/terms-of-service',
    false,
    '{"currency": "GBP", "vendorAliases": {"barry m store": "Barry M", "barrym-cosmetics": "Barry M"}, "priority": "medium", "mvp": "no", "pendingApproval": true, "notes": "Barry M Shopify store (UK, GBP). Verified 2026-11-08: /products.json returns 200 with Shopify products (250+; first page: Nail Paint 106, plus lip and eye cosmetics). Store filter connectors/store-filters/barry-m.ts; Nail Paint is the polish signal. The terms page at the Shopify path is a 404. robots.txt does not disallow products.json. REGISTERED DISABLED AND PENDING: the terms page at the Shopify path is a 404, so whether automated access is allowed is unknown. The owner reads the site terms (or gets the store''s written OK) and records it here as ''Acceptable use confirmed by <name, role> at Barry M on <date> via <channel>: <summary>'', then sets enabled = true and removes pendingApproval.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "firstPageProducts": 250, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": null}}'::jsonb
  ),
  (
    'DazzleDryShopify',
    'api',
    'https://dazzledry.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://dazzledry.com/policies/terms-of-service',
    false,
    '{"currency": "USD", "priority": "medium", "mvp": "no", "pendingApproval": true, "notes": "Dazzle Dry Shopify store (US, USD). Verified 2026-11-08: /products.json returns 200 with Shopify products (250 on page 1; Nail Lacquer 83, (empty) 75, Mini Lacquer 61, Mini Flight 10). robots.txt does not disallow products.json. Terms: Shopify clause (the stock Shopify terms prohibit using a spider, crawl or scrape) — registered disabled, pending the owner''s email (spec §7); enable per README ''Enabling a pending store''.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "firstPageProducts": 250, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": true}}'::jsonb
  ),
  (
    'SundaysShopify',
    'api',
    'https://dearsundays.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://dearsundays.com/policies/terms-of-service',
    false,
    '{"currency": "USD", "priority": "medium", "mvp": "no", "pendingApproval": true, "notes": "Sundays Shopify store (US, USD). Verified 2026-11-08: /products.json returns 200 with Shopify products (94 on page 1; types empty on 89, bundles 3, gift cards 1, Nail Polishes 1; needs a store filter). robots.txt does not disallow products.json. Terms: Shopify clause (the stock Shopify terms prohibit using a spider, crawl or scrape) — registered disabled, pending the owner''s email (spec §7); enable per README ''Enabling a pending store''.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "firstPageProducts": 94, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": true}}'::jsonb
  ),
  (
    'JinsoonShopify',
    'api',
    'https://jinsoon.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://jinsoon.com/policies/terms-of-service',
    false,
    '{"currency": "USD", "priority": "medium", "mvp": "no", "pendingApproval": true, "notes": "JINsoon Shopify store (US, USD). Verified 2026-11-08: /products.json returns 200 with Shopify products (135 on page 1; types empty on 115, Nail Polishes 15, gift cards 4, tool 1; needs a store filter). robots.txt does not disallow products.json. Terms: Shopify clause (the stock Shopify terms prohibit using a spider, crawl or scrape) — registered disabled, pending the owner''s email (spec §7); enable per README ''Enabling a pending store''.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "firstPageProducts": 135, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": true}}'::jsonb
  ),
  (
    'TenovertenShopify',
    'api',
    'https://tenoverten.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://tenoverten.com/policies/terms-of-service',
    false,
    '{"currency": "USD", "priority": "medium", "mvp": "no", "pendingApproval": true, "notes": "Tenoverten Shopify store (US, USD). Verified 2026-11-08: /products.json returns 200 with Shopify products (79 on page 1; 28 of them polishes). robots.txt does not disallow products.json. Terms: Shopify clause (the stock Shopify terms prohibit using a spider, crawl or scrape) — registered disabled, pending the owner''s email (spec §7); enable per README ''Enabling a pending store''.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "firstPageProducts": 79, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": true}}'::jsonb
  ),
  (
    'NailberryShopify',
    'api',
    'https://nailberry.co.uk',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://nailberry.co.uk/policies/terms-of-service',
    false,
    '{"currency": "GBP", "priority": "medium", "mvp": "no", "pendingApproval": true, "notes": "Nailberry Shopify store (UK, GBP). Verified 2026-11-08: /products.json returns 200 with Shopify products (133 on page 1; L''Oxygene 71, Outlet 13, BioGlow 11, gift sets 7, base and top coat 7). robots.txt does not disallow products.json. Terms: Shopify clause (the stock Shopify terms prohibit using a spider, crawl or scrape) — registered disabled, pending the owner''s email (spec §7); enable per README ''Enabling a pending store''.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "firstPageProducts": 133, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": true}}'::jsonb
  ),
  (
    'DndShopify',
    'api',
    'https://dndgel.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://dndgel.com/policies/terms-of-service',
    false,
    '{"currency": "USD", "priority": "medium", "mvp": "no", "pendingApproval": true, "notes": "DND Shopify store (US, USD). Verified 2026-11-08: /products.json returns 200 with Shopify products (250 on page 1; a gel system: (empty) 239, nondiscount 11). robots.txt does not disallow products.json. Terms: Shopify clause (the stock Shopify terms prohibit using a spider, crawl or scrape) — registered disabled, pending the owner''s email (spec §7); enable per README ''Enabling a pending store''. DND is a gel system, gel only: it needs a store filter that honours includeGel before it can be enabled (the generic gate has no gel rule, so includeGel alone changes nothing).", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "firstPageProducts": 250, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": true}}'::jsonb
  ),
  (
    'GlamPolishShopify',
    'api',
    'https://glampolish.com.au',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://glampolish.com.au/policies/terms-of-service',
    false,
    '{"currency": "AUD", "priority": "medium", "mvp": "no", "pendingApproval": true, "notes": "Glam Polish Shopify store (Australia, AUD). Verified 2026-11-08: /products.json returns 200 with Shopify products (250 on page 1; types empty or \"What''s New?\"; more pages follow). robots.txt does not disallow products.json. Terms: Shopify clause (the stock Shopify terms prohibit using a spider, crawl or scrape) — registered disabled, pending the owner''s email (spec §7); enable per README ''Enabling a pending store''.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "firstPageProducts": 250, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": true}}'::jsonb
  ),
  (
    'NailHootShopify',
    'api',
    'https://nailhoot.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://nailhoot.com/policies/terms-of-service',
    false,
    '{"currency": "USD", "priority": "medium", "mvp": "no", "pendingApproval": true, "notes": "Nail Hoot Shopify store (US, USD). Verified 2026-11-08: /products.json returns 200 with Shopify products (230 on page 1; types empty on 128, Bath and Beauty 92, Books 6, Merch 4). robots.txt does not disallow products.json. Terms: Shopify clause (the stock Shopify terms prohibit using a spider, crawl or scrape) — registered disabled, pending the owner''s email (spec §7); enable per README ''Enabling a pending store''.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "firstPageProducts": 230, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": true}}'::jsonb
  ),
  (
    'MoonShineManiShopify',
    'api',
    'https://moonshinemani.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://moonshinemani.com/policies/terms-of-service',
    false,
    '{"currency": "USD", "priority": "medium", "mvp": "no", "pendingApproval": true, "notes": "Moon Shine Mani Shopify store (US, USD). Verified 2026-11-08: /products.json returns 200 with Shopify products (199 on page 1; types empty). robots.txt does not disallow products.json. Terms: Shopify clause (the stock Shopify terms prohibit using a spider, crawl or scrape) — registered disabled, pending the owner''s email (spec §7); enable per README ''Enabling a pending store''.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "firstPageProducts": 199, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": true}}'::jsonb
  ),
  (
    'FunLacquerShopify',
    'api',
    'https://funlacquer.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://funlacquer.com/policies/terms-of-service',
    false,
    '{"currency": "USD", "priority": "medium", "mvp": "no", "pendingApproval": true, "notes": "FUN Lacquer Shopify store (US, USD). Verified 2026-11-08: /products.json returns 200 with Shopify products (250 on page 1; NAIL POLISH 88, GEL POLISH 84). robots.txt does not disallow products.json. Terms: Shopify clause (the stock Shopify terms prohibit using a spider, crawl or scrape) — registered disabled, pending the owner''s email (spec §7); enable per README ''Enabling a pending store''.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "firstPageProducts": 250, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": true}}'::jsonb
  ),
  (
    'AnchorAndHeartShopify',
    'api',
    'https://anchorandheartlacquer.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://anchorandheartlacquer.com/policies/terms-of-service',
    false,
    '{"currency": "USD", "priority": "medium", "mvp": "no", "pendingApproval": true, "notes": "Anchor & Heart Shopify store (US, USD). Verified 2026-11-08: /products.json returns 200 with Shopify products (25 on page 1; Hand Care 8, Top coat 7, Nail Polish 5, Base Coat 4, Body Care 1). robots.txt does not disallow products.json. Terms: Shopify clause (the stock Shopify terms prohibit using a spider, crawl or scrape) — registered disabled, pending the owner''s email (spec §7); enable per README ''Enabling a pending store''.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "firstPageProducts": 25, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": true}}'::jsonb
  ),
  (
    'ButterLondonShopify',
    'api',
    'https://butterlondon.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://butterlondon.com/policies/terms-of-service',
    false,
    '{"currency": "USD", "priority": "medium", "mvp": "no", "pendingApproval": true, "notes": "butter LONDON Shopify store (US, USD). Verified 2026-11-08: /products.json returns 200 with Shopify products (185 on page 1; Nail Polish 41, Lipstick 21, (empty) 11, Lip Gloss 9, Custom Bundle 8). robots.txt does not disallow products.json. Terms: own clause (no \"software robots, spiders, crawlers, or similar data gathering\") — registered disabled, pending the owner''s email (spec §7); enable per README ''Enabling a pending store''.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "firstPageProducts": 185, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": true}}'::jsonb
  ),
  (
    'EllaMilaShopify',
    'api',
    'https://ellamila.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://ellamila.com/policies/terms-of-service',
    false,
    '{"currency": "USD", "priority": "medium", "mvp": "no", "pendingApproval": true, "notes": "Ella+Mila Shopify store (US, USD). Verified 2026-11-08: /products.json returns 200 with Shopify products (250 on page 1; Nail Polishes 162, (empty) 44, Nail Sticker 29, Cuticle Cream & Oil 6). robots.txt does not disallow products.json. Terms: own clause (automated access only for search engines that honour robots.txt) — registered disabled, pending the owner''s email (spec §7); enable per README ''Enabling a pending store''.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "firstPageProducts": 250, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": true}}'::jsonb
  ),
  (
    'KiaraSkyShopify',
    'api',
    'https://kiarasky.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://kiarasky.com/policies/terms-of-service',
    false,
    '{"currency": "USD", "priority": "medium", "mvp": "no", "pendingApproval": true, "notes": "Kiara Sky Shopify store (US, USD). Verified 2026-11-08: /products.json returns 200 with Shopify products (250 on page 1; gel-heavy: HF Gel Polish 149, Fixed Bundle 34, Gel Extensions 34, SERVICE 14). robots.txt does not disallow products.json. Terms: own clause (no \"software robots, spiders, crawlers, or similar data gathering\") — registered disabled, pending the owner''s email (spec §7); enable per README ''Enabling a pending store''.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "firstPageProducts": 250, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": true}}'::jsonb
  ),
  (
    'StaticNailsShopify',
    'api',
    'https://staticnails.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://staticnails.com/policies/terms-of-service',
    false,
    '{"currency": "USD", "priority": "medium", "mvp": "no", "pendingApproval": true, "notes": "Static Nails Shopify store (US, USD). Verified 2026-11-08: /products.json returns 200 with Shopify products (250 on page 1; Reusable Pop-On Manicures 97, Liquid Glass Lacquer 70). robots.txt does not disallow products.json. Terms: own clause (no \"software robots, spiders, crawlers, or similar data gathering\") — registered disabled, pending the owner''s email (spec §7); enable per README ''Enabling a pending store''.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "firstPageProducts": 250, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": true}}'::jsonb
  ),
  (
    'PacificaShopify',
    'api',
    'https://pacificabeauty.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://pacificabeauty.com/policies/terms-of-service',
    false,
    '{"currency": "USD", "priority": "medium", "mvp": "no", "pendingApproval": true, "notes": "Pacifica Shopify store (US, USD). Verified 2026-11-08: /products.json returns 200 with Shopify products (250 on page 1; mostly cosmetics: Skin Care 60, Perfume 46, Makeup 33, Haircare 32; polish is a small share). robots.txt does not disallow products.json. Terms: own clause (no \"software robots, spiders, crawlers, or similar data gathering\") — registered disabled, pending the owner''s email (spec §7); enable per README ''Enabling a pending store''.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "firstPageProducts": 250, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": true}}'::jsonb
  ),
  (
    'RevlonShopify',
    'api',
    'https://revlon.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://revlon.com/policies/terms-of-service',
    false,
    '{"currency": "USD", "priority": "medium", "mvp": "no", "pendingApproval": true, "notes": "Revlon Shopify store (US, USD). Verified 2026-11-08: /products.json returns 200 with Shopify products (147 on page 1; a makeup store, polish not on page 1: Tweezers 11, Eyeliner 8, Eye Shadow 7, Foundation 7). robots.txt does not disallow products.json. Terms: own clause (no \"deep link\", \"page-scrape\", \"robot\", \"spider\" or other automatic device) — registered disabled, pending the owner''s email (spec §7); enable per README ''Enabling a pending store''.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "firstPageProducts": 147, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": true}}'::jsonb
  ),
  (
    'ModelonesShopify',
    'api',
    'https://modelones.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://modelones.com/policies/terms-of-service',
    false,
    '{"currency": "USD", "priority": "medium", "mvp": "no", "pendingApproval": true, "notes": "Modelones Shopify store (US, USD). Verified 2026-11-08: /products.json returns 200 with Shopify products (250 on page 1; PL 212, Gel Polish Set 8, press on nails 5, Top&Base Coat 5, Nail Tools 4). robots.txt does not disallow products.json. Terms: own clause (no harvesting, scraping, crawling or collecting information about other users) — registered disabled, pending the owner''s email (spec §7); enable per README ''Enabling a pending store''.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "firstPageProducts": 250, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": true}}'::jsonb
  ),
  (
    'DreamlandLacquerShopify',
    'api',
    'https://dreamlandlacquer.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://dreamlandlacquer.com/policies/terms-of-service',
    false,
    '{"currency": "USD", "priority": "medium", "mvp": "no", "pendingApproval": true, "notes": "Dreamland Lacquer Shopify store (US, USD). Verified 2026-11-08: /products.json returns 200 with Shopify products (72 on page 1; Nail Polishes 50, (empty) 11, Whimsy Wares 8, Accessories 3). robots.txt does not disallow products.json. Terms: own clause (no \"any robot, spider, scraping, data gathering and extraction\" tool) — registered disabled, pending the owner''s email (spec §7); enable per README ''Enabling a pending store''.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "firstPageProducts": 72, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": true}}'::jsonb
  ),
  (
    'EtherealLacquerShopify',
    'api',
    'https://ethereallacquer.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://ethereallacquer.com/policies/terms-of-service',
    false,
    '{"currency": "USD", "priority": "medium", "mvp": "no", "pendingApproval": true, "notes": "Ethereal Lacquer Shopify store (US, USD). Verified 2026-11-08: /products.json returns 200 with Shopify products (9 on page 1; types empty on all 9). robots.txt does not disallow products.json. Terms: own clause (no \"any robot, spider, scraping, data gathering and extraction\" tool) — registered disabled, pending the owner''s email (spec §7); enable per README ''Enabling a pending store''.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "firstPageProducts": 9, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": true}}'::jsonb
  ),
  (
    'OpiSitemap',
    'api',
    'https://www.opi.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    NULL,
    false,
    '{"brand": "OPI", "sitemapUrl": "https://www.opi.com/sitemap.xml", "productUrlPrefixes": ["https://www.opi.com/products/nail-lacquer-", "https://www.opi.com/products/infinite-shine-"], "currency": "USD", "priority": "medium", "mvp": "no", "pendingApproval": true, "notes": "OPI brand store (US, USD), read through its sitemap and product-page JSON-LD (SitemapJsonLd connector, brand sources plan Task 15). Verified 2026-11-08: https://www.opi.com/sitemap.xml is a <urlset> of 1,898 pages, 575 of them under the two product prefixes (nail-lacquer-, infinite-shine-); a product page carries one application/ld+json Product with gtin, sku, brand, images and offers. Terms: no terms page at /terms-of-use on 2026-11-08, so whether automated access is allowed is unknown. REGISTERED DISABLED AND PENDING: the owner locates and reads OPI''s site terms and asks for the OK, records it here as ''Acceptable use confirmed by <name, role> at OPI on <date> via <channel>: <summary>'', then sets enabled = true and removes pendingApproval. The crawl needs CONNECTOR_RAW_CONTAINER (a durable catalog cache).", "verification": {"checkedAt": "2026-11-08", "sitemap": true, "productUrls": "1898-page sitemap on 2026-11-08 (575 under the product prefixes)", "jsonLdProduct": true, "termsScrapingClause": null}}'::jsonb
  ),
  (
    'PicturePolishWooCommerce',
    'api',
    'https://picturepolish.com.au',
    'Storefront terms apply (verify metadata/image usage obligations)',
    NULL,
    true,
    '{"brand": "Picture Polish", "currency": "AUD", "priority": "medium", "mvp": "no", "notes": "Picture Polish brand store (Australia, AUD), read through the WooCommerce Store API (WooCommerce connector, brand sources plan Task 16). Verified 2026-11-08: https://picturepolish.com.au/wp-json/wc/store/v1/products answered 200 with WooCommerce Store API products (143 products, all simple, on 2026-11-10). The store filter connectors/store-filters/picture-polish.ts keeps Nail Colours unless the product is also in Bundles, drops Bundles and leaves the rest to the generic gate: 116 of 143 kept, measured offline on 2026-11-10 (104 colour, 5 top coats, 3 base coats, 3 treatments, 1 accessory by name); its title parser takes the shade name from the first | segment (Camelot | Purple | Flakie gives Camelot). Terms: https://picturepolish.com.au/terms-conditions/ (read 2026-11-10): site access \"does not include the right to use any data mining robots or other extraction tools\"; copying or republishing site information needs prior written permission; \"Linking our website is not permitted\". robots.txt does not disallow /wp-json/. The connector checks robots.txt before any product request. Enabled on 2026-11-10 by the owner''s decision without a store OK; ask the maker for the record.", "verification": {"checkedAt": "2026-11-08", "storeApi": true, "robotsTxt": "store-api-not-disallowed", "termsScrapingClause": true, "termsUrl": "https://picturepolish.com.au/terms-conditions/", "termsCheckedAt": "2026-11-10", "products": 143, "storeFilterPass": 116, "storeFilterCheckedAt": "2026-11-10"}}'::jsonb
  ),
  (
    'IlnpWooCommerce',
    'api',
    'https://ilnp.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    NULL,
    false,
    '{"brand": "ILNP", "currency": "USD", "priority": "high", "mvp": "no", "pendingApproval": true, "blocked": "robots", "notes": "ILNP brand store (US, USD) on WooCommerce. KNOWN BLOCKED: its robots.txt disallows /wp-json/ and /wc/store/v1/ (October 2026 survey; the Store API itself answered 200), so the WooCommerce connector refuses to run it (WooCommerce Store API disallowed by robots.txt). Registered disabled so the admin console lists it as a known-blocked source; ILNP is reached through resellers instead (Harlow & Co, Hypnotic Polish; docs/brand-sources-evaluation-2026-11.md). Enable only with ILNP''s written OK recorded here as ''Acceptable use confirmed by <name, role> at ILNP on <date> via <channel>: <summary>'' and a robots.txt that allows the Store API.", "verification": {"checkedAt": "2026-11-08", "storeApi": true, "robotsTxt": "store-api-disallowed", "termsScrapingClause": null}}'::jsonb
  ),
  (
    'KbshimmerWooCommerce',
    'api',
    'https://kbshimmer.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    NULL,
    false,
    '{"brand": "KBShimmer", "currency": "USD", "priority": "high", "mvp": "no", "pendingApproval": true, "blocked": "cloudflare", "notes": "KBShimmer brand store (US, USD) on WordPress. KNOWN BLOCKED: every path answers a Cloudflare challenge (403) to automated requests (November 2026 probe), so the Store API cannot be read. Registered disabled so the admin console lists it as a known-blocked source; KBShimmer is reached through resellers instead (Harlow & Co, Beyond Polish; docs/brand-sources-evaluation-2026-11.md). Enable only with KBShimmer''s written OK recorded here as ''Acceptable use confirmed by <name, role> at KBShimmer on <date> via <channel>: <summary>'' and access that does not hit the challenge.", "verification": {"checkedAt": "2026-11-08", "storeApi": false, "cloudflareChallenge": true, "termsScrapingClause": null}}'::jsonb
  ),
  (
    'PaintedPolishBigCartel',
    'api',
    'https://paintedpolish.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    NULL,
    true,
    '{"brand": "Painted Polish", "subdomain": "paintedpolish", "priority": "medium", "mvp": "no", "notes": "Painted Polish brand store on Big Cartel, read through the Big Cartel v0 API (BigCartel connector, brand sources plan Task 17). Painted Polish''s own domain answered 404 for /products.json on 2026-11-08 and sits behind Cloudflare; the v0 API answers under the subdomain paintedpolish. Verified 2026-11-08: https://api.bigcartel.com/paintedpolish/products.json answered 200 with 287 products (135 active, 152 sold-out). The generic gate keeps 47 of its products (2026-11-08); the store filter connectors/store-filters/painted-polish.ts keeps Individual Shades, drops Sets and the Imperfect Label Bottles listing and leaves the rest to the generic gate: 246 of 287 kept, measured offline on 2026-11-10; its title parser drops one trailing parenthetical stock note that says FINAL (Pumpkin To Talk About (FINAL 3 BOTTLES) gives Pumpkin To Talk About). The store currency comes from the API''s store.json at ingest time. Terms: the Big Cartel API License Agreement (https://www.bigcartel.com/resources/help/article/api-license-agreement, dated 07.21.23, read 2026-11-10) governs this store: displaying a shop''s public listings in an application is a permitted use, but an application may not display content \"more than six hours older\" than the shop, must delete public content once it is no longer public, and may not \"create a database by downloading and storing the Content\" beyond a cache. SwatchWatch keeps shades permanently, so the catalog does not meet those terms. The store''s own terms page was not found (404 at /terms and /terms-and-conditions on 2026-11-10). Enabled on 2026-11-10 by the owner''s decision without a store OK; ask the maker for the record.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "productsJsonUrl": "https://api.bigcartel.com/paintedpolish/products.json", "products": 287, "connectorGatePass": 47, "storeJson": null, "termsScrapingClause": null, "storeFilterPass": 246, "storeFilterCheckedAt": "2026-11-10", "termsCheckedAt": "2026-11-10", "apiLicenseUrl": "https://www.bigcartel.com/resources/help/article/api-license-agreement", "apiLicenseDated": "2023-07-21", "apiLicenseStorageClause": true, "storeTermsFound": false}}'::jsonb
  ),
  (
    'PotionPolishBigCartel',
    'api',
    'https://www.potionpolish.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    NULL,
    true,
    '{"brand": "Potion Polish", "subdomain": "potionpolish", "priority": "medium", "mvp": "no", "notes": "Potion Polish brand store on Big Cartel, read through the Big Cartel v0 API (BigCartel connector, brand sources plan Task 17). Replaces the disabled PotionPolishShopify row (the store moved from Shopify to Big Cartel). Verified 2026-11-08: https://api.bigcartel.com/potionpolish/products.json answered 200 with 35 products (33 active, 2 sold-out). The generic gate keeps 0 of its products (2026-11-08: its categories are finish and collection names); the store filter connectors/store-filters/potion-polish.ts keeps every product except the Mystery Polish category: 32 of 35 kept, measured offline on 2026-11-10; its title parser drops trailing notes after a dash (Limited Edition, Magnetic, Last Chance For Now!, Back In Stock ...), so Autumn Enthusiast - Magnetic - Limited Edition gives Autumn Enthusiast. The store currency comes from the API''s store.json at ingest time. Terms: the Big Cartel API License Agreement (https://www.bigcartel.com/resources/help/article/api-license-agreement, dated 07.21.23, read 2026-11-10) governs this store: displaying a shop''s public listings in an application is a permitted use, but an application may not display content \"more than six hours older\" than the shop, must delete public content once it is no longer public, and may not \"create a database by downloading and storing the Content\" beyond a cache. SwatchWatch keeps shades permanently, so the catalog does not meet those terms. The store''s own terms page was not found (404 at /terms and /terms-and-conditions on 2026-11-10). Enabled on 2026-11-10 by the owner''s decision without a store OK; ask the maker for the record.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "productsJsonUrl": "https://api.bigcartel.com/potionpolish/products.json", "products": 35, "connectorGatePass": 0, "storeJson": null, "termsScrapingClause": null, "storeFilterPass": 32, "storeFilterCheckedAt": "2026-11-10", "termsCheckedAt": "2026-11-10", "apiLicenseUrl": "https://www.bigcartel.com/resources/help/article/api-license-agreement", "apiLicenseDated": "2023-07-21", "apiLicenseStorageClause": true, "storeTermsFound": false}}'::jsonb
  ),
  (
    'ColoresDeCarolBigCartel',
    'api',
    'https://coloresdecarol.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    NULL,
    false,
    '{"brand": "Colores de Carol", "subdomain": "coloresdecarol", "priority": "medium", "mvp": "no", "pendingApproval": true, "notes": "Colores de Carol brand store on Big Cartel, read through the Big Cartel v0 API (BigCartel connector, brand sources plan Task 17). The store''s own domain sits behind Cloudflare; the v0 API answers under the subdomain coloresdecarol. Verified 2026-11-08: https://api.bigcartel.com/coloresdecarol/products.json answered 200 with 265 products (223 active, 42 sold-out); the shared connector gate (categories as product type and tags) keeps 223 of them (2026-11-08). The store currency comes from the API''s store.json at ingest time. Terms: not read yet. REGISTERED DISABLED AND PENDING: the owner reads Big Cartel''s API License Agreement (linked from developers.bigcartel.com/api/v0) and the store''s terms and asks for the OK, records it here as ''Acceptable use confirmed by <name, role> at Colores de Carol on <date> via <channel>: <summary>'', then sets enabled = true and removes pendingApproval.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "productsJsonUrl": "https://api.bigcartel.com/coloresdecarol/products.json", "products": 265, "connectorGatePass": 223, "storeJson": null, "termsScrapingClause": null}}'::jsonb
  ),
  (
    'GlistenAndGlowBigCartel',
    'api',
    'https://glistenandglow.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    NULL,
    false,
    '{"brand": "Glisten & Glow", "subdomain": "glistenandglow", "priority": "medium", "mvp": "no", "pendingApproval": true, "notes": "Glisten & Glow brand store on Big Cartel, read through the Big Cartel v0 API (BigCartel connector, brand sources plan Task 17). Verified 2026-11-08: https://api.bigcartel.com/glistenandglow/products.json answered 200 with 278 products (278 active); the shared connector gate (categories as product type and tags) keeps 99 of them (2026-11-08). The store currency comes from the API''s store.json at ingest time. Terms: not read yet. REGISTERED DISABLED AND PENDING: the owner reads Big Cartel''s API License Agreement (linked from developers.bigcartel.com/api/v0) and the store''s terms and asks for the OK, records it here as ''Acceptable use confirmed by <name, role> at Glisten & Glow on <date> via <channel>: <summary>'', then sets enabled = true and removes pendingApproval.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "productsJsonUrl": "https://api.bigcartel.com/glistenandglow/products.json", "products": 278, "connectorGatePass": 99, "storeJson": null, "termsScrapingClause": null}}'::jsonb
  ),
  (
    'PoetryCowgirlBigCartel',
    'api',
    'https://poetrycowgirlnailpolish.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    NULL,
    false,
    '{"brand": "Poetry Cowgirl Nail Polish", "subdomain": "poetrycowgirlnailpolish", "priority": "low", "mvp": "no", "pendingApproval": true, "notes": "Poetry Cowgirl Nail Polish brand store on Big Cartel, read through the Big Cartel v0 API (BigCartel connector, brand sources plan Task 17). Verified 2026-11-08: https://api.bigcartel.com/poetrycowgirlnailpolish/products.json answered 200 with 207 products (132 active, 75 sold-out). Needs a store filter before enabling: the generic gate keeps 9 of its products (2026-11-08). The store currency comes from the API''s store.json at ingest time. Terms: not read yet. REGISTERED DISABLED AND PENDING: the owner reads Big Cartel''s API License Agreement (linked from developers.bigcartel.com/api/v0) and the store''s terms and asks for the OK, records it here as ''Acceptable use confirmed by <name, role> at Poetry Cowgirl Nail Polish on <date> via <channel>: <summary>'', then sets enabled = true and removes pendingApproval.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "productsJsonUrl": "https://api.bigcartel.com/poetrycowgirlnailpolish/products.json", "products": 207, "connectorGatePass": 9, "storeJson": null, "termsScrapingClause": null}}'::jsonb
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
