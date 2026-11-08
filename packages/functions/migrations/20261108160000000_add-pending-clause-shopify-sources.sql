-- Up Migration

-- 20261108160000000_add-pending-clause-shopify-sources.sql
-- Registers twenty brand Shopify stores whose terms carry an automated-access clause (brand
-- sources plan, Task 12; the probe is in docs/brand-sources-evaluation-2026-11.md): eleven with the
-- stock Shopify clause (Dazzle Dry, Sundays, JINsoon, Tenoverten, Nailberry, DND, Glam Polish,
-- Nail Hoot, Moon Shine Mani, FUN Lacquer, Anchor & Heart) and nine with a clause of their own
-- (butter LONDON, Ella+Mila, Kiara Sky, Static Nails, Pacifica, Revlon, Modelones, Dreamland
-- Lacquer, Ethereal Lacquer). They are BRAND stores (no metadata.kind), registered DISABLED and
-- PENDING until the owner's email is answered (spec section 7); no store filter, no ingestion.
-- They are in SHOPIFY_SOURCES_PENDING_APPROVAL, so code that reaches an environment first
-- provisions them disabled too. Keep in sync with docs/seed_data_sources.sql.
--
-- Rollback safety (the pending-row pattern of 20261108150000000): the rows are insert only
-- (ON CONFLICT DO NOTHING), so an existing row is never changed, enabled or disabled; a row this
-- migration INSERTS is stamped metadata.insertedByMigration; the Down section deletes only a
-- stamped row without ingestion history, disables a stamped row that has history, and never
-- touches anything else.

BEGIN;

INSERT INTO data_source (name, source_type, base_url, license, terms_url, enabled, metadata)
VALUES
  (
    'DazzleDryShopify',
    'api',
    'https://dazzledry.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://dazzledry.com/policies/terms-of-service',
    false,
    '{"currency": "USD", "priority": "medium", "mvp": "no", "pendingApproval": true, "notes": "Dazzle Dry Shopify store (US, USD). Verified 2026-11-08: /products.json returns 200 with Shopify products (250 on page 1; Nail Lacquer 83, (empty) 75, Mini Lacquer 61, Mini Flight 10). robots.txt does not disallow products.json. Terms: Shopify clause (the stock Shopify terms prohibit using a spider, crawl or scrape) — registered disabled, pending the owner''s email (spec §7); enable per README ''Enabling a pending store''.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "firstPageProducts": 250, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": true}, "insertedByMigration": "20261108160000000"}'::jsonb
  ),
  (
    'SundaysShopify',
    'api',
    'https://dearsundays.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://dearsundays.com/policies/terms-of-service',
    false,
    '{"currency": "USD", "priority": "medium", "mvp": "no", "pendingApproval": true, "notes": "Sundays Shopify store (US, USD). Verified 2026-11-08: /products.json returns 200 with Shopify products (94 on page 1; types empty on 89, bundles 3, gift cards 1, Nail Polishes 1; needs a store filter). robots.txt does not disallow products.json. Terms: Shopify clause (the stock Shopify terms prohibit using a spider, crawl or scrape) — registered disabled, pending the owner''s email (spec §7); enable per README ''Enabling a pending store''.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "firstPageProducts": 94, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": true}, "insertedByMigration": "20261108160000000"}'::jsonb
  ),
  (
    'JinsoonShopify',
    'api',
    'https://jinsoon.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://jinsoon.com/policies/terms-of-service',
    false,
    '{"currency": "USD", "priority": "medium", "mvp": "no", "pendingApproval": true, "notes": "JINsoon Shopify store (US, USD). Verified 2026-11-08: /products.json returns 200 with Shopify products (135 on page 1; types empty on 115, Nail Polishes 15, gift cards 4, tool 1; needs a store filter). robots.txt does not disallow products.json. Terms: Shopify clause (the stock Shopify terms prohibit using a spider, crawl or scrape) — registered disabled, pending the owner''s email (spec §7); enable per README ''Enabling a pending store''.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "firstPageProducts": 135, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": true}, "insertedByMigration": "20261108160000000"}'::jsonb
  ),
  (
    'TenovertenShopify',
    'api',
    'https://tenoverten.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://tenoverten.com/policies/terms-of-service',
    false,
    '{"currency": "USD", "priority": "medium", "mvp": "no", "pendingApproval": true, "notes": "Tenoverten Shopify store (US, USD). Verified 2026-11-08: /products.json returns 200 with Shopify products (79 on page 1; 28 of them polishes). robots.txt does not disallow products.json. Terms: Shopify clause (the stock Shopify terms prohibit using a spider, crawl or scrape) — registered disabled, pending the owner''s email (spec §7); enable per README ''Enabling a pending store''.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "firstPageProducts": 79, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": true}, "insertedByMigration": "20261108160000000"}'::jsonb
  ),
  (
    'NailberryShopify',
    'api',
    'https://nailberry.co.uk',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://nailberry.co.uk/policies/terms-of-service',
    false,
    '{"currency": "GBP", "priority": "medium", "mvp": "no", "pendingApproval": true, "notes": "Nailberry Shopify store (UK, GBP). Verified 2026-11-08: /products.json returns 200 with Shopify products (133 on page 1; L''Oxygene 71, Outlet 13, BioGlow 11, gift sets 7, base and top coat 7). robots.txt does not disallow products.json. Terms: Shopify clause (the stock Shopify terms prohibit using a spider, crawl or scrape) — registered disabled, pending the owner''s email (spec §7); enable per README ''Enabling a pending store''.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "firstPageProducts": 133, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": true}, "insertedByMigration": "20261108160000000"}'::jsonb
  ),
  (
    'DndShopify',
    'api',
    'https://dndgel.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://dndgel.com/policies/terms-of-service',
    false,
    '{"currency": "USD", "priority": "medium", "mvp": "no", "pendingApproval": true, "notes": "DND Shopify store (US, USD). Verified 2026-11-08: /products.json returns 200 with Shopify products (250 on page 1; a gel system: (empty) 239, nondiscount 11). robots.txt does not disallow products.json. Terms: Shopify clause (the stock Shopify terms prohibit using a spider, crawl or scrape) — registered disabled, pending the owner''s email (spec §7); enable per README ''Enabling a pending store''. DND is a gel system: its products are gel polish, so includeGel must be true in the row''s metadata for it to ingest anything.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "firstPageProducts": 250, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": true}, "insertedByMigration": "20261108160000000"}'::jsonb
  ),
  (
    'GlamPolishShopify',
    'api',
    'https://glampolish.com.au',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://glampolish.com.au/policies/terms-of-service',
    false,
    '{"currency": "AUD", "priority": "medium", "mvp": "no", "pendingApproval": true, "notes": "Glam Polish Shopify store (Australia, AUD). Verified 2026-11-08: /products.json returns 200 with Shopify products (250 on page 1; types empty or \"What''s New?\"; more pages follow). robots.txt does not disallow products.json. Terms: Shopify clause (the stock Shopify terms prohibit using a spider, crawl or scrape) — registered disabled, pending the owner''s email (spec §7); enable per README ''Enabling a pending store''.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "firstPageProducts": 250, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": true}, "insertedByMigration": "20261108160000000"}'::jsonb
  ),
  (
    'NailHootShopify',
    'api',
    'https://nailhoot.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://nailhoot.com/policies/terms-of-service',
    false,
    '{"currency": "USD", "priority": "medium", "mvp": "no", "pendingApproval": true, "notes": "Nail Hoot Shopify store (US, USD). Verified 2026-11-08: /products.json returns 200 with Shopify products (230 on page 1; types empty on 128, Bath and Beauty 92, Books 6, Merch 4). robots.txt does not disallow products.json. Terms: Shopify clause (the stock Shopify terms prohibit using a spider, crawl or scrape) — registered disabled, pending the owner''s email (spec §7); enable per README ''Enabling a pending store''.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "firstPageProducts": 230, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": true}, "insertedByMigration": "20261108160000000"}'::jsonb
  ),
  (
    'MoonShineManiShopify',
    'api',
    'https://moonshinemani.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://moonshinemani.com/policies/terms-of-service',
    false,
    '{"currency": "USD", "priority": "medium", "mvp": "no", "pendingApproval": true, "notes": "Moon Shine Mani Shopify store (US, USD). Verified 2026-11-08: /products.json returns 200 with Shopify products (199 on page 1; types empty). robots.txt does not disallow products.json. Terms: Shopify clause (the stock Shopify terms prohibit using a spider, crawl or scrape) — registered disabled, pending the owner''s email (spec §7); enable per README ''Enabling a pending store''.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "firstPageProducts": 199, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": true}, "insertedByMigration": "20261108160000000"}'::jsonb
  ),
  (
    'FunLacquerShopify',
    'api',
    'https://funlacquer.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://funlacquer.com/policies/terms-of-service',
    false,
    '{"currency": "USD", "priority": "medium", "mvp": "no", "pendingApproval": true, "notes": "FUN Lacquer Shopify store (US, USD). Verified 2026-11-08: /products.json returns 200 with Shopify products (250 on page 1; NAIL POLISH 88, GEL POLISH 84). robots.txt does not disallow products.json. Terms: Shopify clause (the stock Shopify terms prohibit using a spider, crawl or scrape) — registered disabled, pending the owner''s email (spec §7); enable per README ''Enabling a pending store''.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "firstPageProducts": 250, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": true}, "insertedByMigration": "20261108160000000"}'::jsonb
  ),
  (
    'AnchorAndHeartShopify',
    'api',
    'https://anchorandheartlacquer.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://anchorandheartlacquer.com/policies/terms-of-service',
    false,
    '{"currency": "USD", "priority": "medium", "mvp": "no", "pendingApproval": true, "notes": "Anchor & Heart Shopify store (US, USD). Verified 2026-11-08: /products.json returns 200 with Shopify products (25 on page 1; Hand Care 8, Top coat 7, Nail Polish 5, Base Coat 4, Body Care 1). robots.txt does not disallow products.json. Terms: Shopify clause (the stock Shopify terms prohibit using a spider, crawl or scrape) — registered disabled, pending the owner''s email (spec §7); enable per README ''Enabling a pending store''.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "firstPageProducts": 25, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": true}, "insertedByMigration": "20261108160000000"}'::jsonb
  ),
  (
    'ButterLondonShopify',
    'api',
    'https://butterlondon.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://butterlondon.com/policies/terms-of-service',
    false,
    '{"currency": "USD", "priority": "medium", "mvp": "no", "pendingApproval": true, "notes": "butter LONDON Shopify store (US, USD). Verified 2026-11-08: /products.json returns 200 with Shopify products (185 on page 1; Nail Polish 41, Lipstick 21, (empty) 11, Lip Gloss 9, Custom Bundle 8). robots.txt does not disallow products.json. Terms: own clause (no \"software robots, spiders, crawlers, or similar data gathering\") — registered disabled, pending the owner''s email (spec §7); enable per README ''Enabling a pending store''.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "firstPageProducts": 185, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": true}, "insertedByMigration": "20261108160000000"}'::jsonb
  ),
  (
    'EllaMilaShopify',
    'api',
    'https://ellamila.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://ellamila.com/policies/terms-of-service',
    false,
    '{"currency": "USD", "priority": "medium", "mvp": "no", "pendingApproval": true, "notes": "Ella+Mila Shopify store (US, USD). Verified 2026-11-08: /products.json returns 200 with Shopify products (250 on page 1; Nail Polishes 162, (empty) 44, Nail Sticker 29, Cuticle Cream & Oil 6). robots.txt does not disallow products.json. Terms: own clause (automated access only for search engines that honour robots.txt) — registered disabled, pending the owner''s email (spec §7); enable per README ''Enabling a pending store''.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "firstPageProducts": 250, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": true}, "insertedByMigration": "20261108160000000"}'::jsonb
  ),
  (
    'KiaraSkyShopify',
    'api',
    'https://kiarasky.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://kiarasky.com/policies/terms-of-service',
    false,
    '{"currency": "USD", "priority": "medium", "mvp": "no", "pendingApproval": true, "notes": "Kiara Sky Shopify store (US, USD). Verified 2026-11-08: /products.json returns 200 with Shopify products (250 on page 1; gel-heavy: HF Gel Polish 149, Fixed Bundle 34, Gel Extensions 34, SERVICE 14). robots.txt does not disallow products.json. Terms: own clause (no \"software robots, spiders, crawlers, or similar data gathering\") — registered disabled, pending the owner''s email (spec §7); enable per README ''Enabling a pending store''.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "firstPageProducts": 250, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": true}, "insertedByMigration": "20261108160000000"}'::jsonb
  ),
  (
    'StaticNailsShopify',
    'api',
    'https://staticnails.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://staticnails.com/policies/terms-of-service',
    false,
    '{"currency": "USD", "priority": "medium", "mvp": "no", "pendingApproval": true, "notes": "Static Nails Shopify store (US, USD). Verified 2026-11-08: /products.json returns 200 with Shopify products (250 on page 1; Reusable Pop-On Manicures 97, Liquid Glass Lacquer 70). robots.txt does not disallow products.json. Terms: own clause (no \"software robots, spiders, crawlers, or similar data gathering\") — registered disabled, pending the owner''s email (spec §7); enable per README ''Enabling a pending store''.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "firstPageProducts": 250, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": true}, "insertedByMigration": "20261108160000000"}'::jsonb
  ),
  (
    'PacificaShopify',
    'api',
    'https://pacificabeauty.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://pacificabeauty.com/policies/terms-of-service',
    false,
    '{"currency": "USD", "priority": "medium", "mvp": "no", "pendingApproval": true, "notes": "Pacifica Shopify store (US, USD). Verified 2026-11-08: /products.json returns 200 with Shopify products (250 on page 1; mostly cosmetics: Skin Care 60, Perfume 46, Makeup 33, Haircare 32; polish is a small share). robots.txt does not disallow products.json. Terms: own clause (no \"software robots, spiders, crawlers, or similar data gathering\") — registered disabled, pending the owner''s email (spec §7); enable per README ''Enabling a pending store''.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "firstPageProducts": 250, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": true}, "insertedByMigration": "20261108160000000"}'::jsonb
  ),
  (
    'RevlonShopify',
    'api',
    'https://revlon.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://revlon.com/policies/terms-of-service',
    false,
    '{"currency": "USD", "priority": "medium", "mvp": "no", "pendingApproval": true, "notes": "Revlon Shopify store (US, USD). Verified 2026-11-08: /products.json returns 200 with Shopify products (147 on page 1; a makeup store, polish not on page 1: Tweezers 11, Eyeliner 8, Eye Shadow 7, Foundation 7). robots.txt does not disallow products.json. Terms: own clause (no \"deep link\", \"page-scrape\", \"robot\", \"spider\" or other automatic device) — registered disabled, pending the owner''s email (spec §7); enable per README ''Enabling a pending store''.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "firstPageProducts": 147, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": true}, "insertedByMigration": "20261108160000000"}'::jsonb
  ),
  (
    'ModelonesShopify',
    'api',
    'https://modelones.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://modelones.com/policies/terms-of-service',
    false,
    '{"currency": "USD", "priority": "medium", "mvp": "no", "pendingApproval": true, "notes": "Modelones Shopify store (US, USD). Verified 2026-11-08: /products.json returns 200 with Shopify products (250 on page 1; PL 212, Gel Polish Set 8, press on nails 5, Top&Base Coat 5, Nail Tools 4). robots.txt does not disallow products.json. Terms: own clause (no harvesting, scraping, crawling or collecting information about other users) — registered disabled, pending the owner''s email (spec §7); enable per README ''Enabling a pending store''.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "firstPageProducts": 250, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": true}, "insertedByMigration": "20261108160000000"}'::jsonb
  ),
  (
    'DreamlandLacquerShopify',
    'api',
    'https://dreamlandlacquer.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://dreamlandlacquer.com/policies/terms-of-service',
    false,
    '{"currency": "USD", "priority": "medium", "mvp": "no", "pendingApproval": true, "notes": "Dreamland Lacquer Shopify store (US, USD). Verified 2026-11-08: /products.json returns 200 with Shopify products (72 on page 1; Nail Polishes 50, (empty) 11, Whimsy Wares 8, Accessories 3). robots.txt does not disallow products.json. Terms: own clause (no \"any robot, spider, scraping, data gathering and extraction\" tool) — registered disabled, pending the owner''s email (spec §7); enable per README ''Enabling a pending store''.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "firstPageProducts": 72, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": true}, "insertedByMigration": "20261108160000000"}'::jsonb
  ),
  (
    'EtherealLacquerShopify',
    'api',
    'https://ethereallacquer.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://ethereallacquer.com/policies/terms-of-service',
    false,
    '{"currency": "USD", "priority": "medium", "mvp": "no", "pendingApproval": true, "notes": "Ethereal Lacquer Shopify store (US, USD). Verified 2026-11-08: /products.json returns 200 with Shopify products (9 on page 1; types empty on all 9). robots.txt does not disallow products.json. Terms: own clause (no \"any robot, spider, scraping, data gathering and extraction\" tool) — registered disabled, pending the owner''s email (spec §7); enable per README ''Enabling a pending store''.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "firstPageProducts": 9, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": true}, "insertedByMigration": "20261108160000000"}'::jsonb
  )
ON CONFLICT (name) DO NOTHING;

COMMIT;


-- Down Migration
-- Remove the rows Up inserted unless something already ran against them (ingestion_job and
-- external_product cascade on delete, so a row with history is left in place, disabled).
BEGIN;

UPDATE data_source
SET enabled = false
WHERE name IN ('DazzleDryShopify', 'SundaysShopify', 'JinsoonShopify', 'TenovertenShopify', 'NailberryShopify', 'DndShopify', 'GlamPolishShopify', 'NailHootShopify', 'MoonShineManiShopify', 'FunLacquerShopify', 'AnchorAndHeartShopify', 'ButterLondonShopify', 'EllaMilaShopify', 'KiaraSkyShopify', 'StaticNailsShopify', 'PacificaShopify', 'RevlonShopify', 'ModelonesShopify', 'DreamlandLacquerShopify', 'EtherealLacquerShopify')
  AND metadata->>'insertedByMigration' = '20261108160000000';

DELETE FROM data_source AS ds
WHERE ds.name IN ('DazzleDryShopify', 'SundaysShopify', 'JinsoonShopify', 'TenovertenShopify', 'NailberryShopify', 'DndShopify', 'GlamPolishShopify', 'NailHootShopify', 'MoonShineManiShopify', 'FunLacquerShopify', 'AnchorAndHeartShopify', 'ButterLondonShopify', 'EllaMilaShopify', 'KiaraSkyShopify', 'StaticNailsShopify', 'PacificaShopify', 'RevlonShopify', 'ModelonesShopify', 'DreamlandLacquerShopify', 'EtherealLacquerShopify')
  AND ds.metadata->>'insertedByMigration' = '20261108160000000'
  AND NOT EXISTS (SELECT 1 FROM ingestion_job j WHERE j.data_source_id = ds.data_source_id)
  AND NOT EXISTS (SELECT 1 FROM external_product e WHERE e.data_source_id = ds.data_source_id);

COMMIT;
