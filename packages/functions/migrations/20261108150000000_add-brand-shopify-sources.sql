-- Up Migration

-- 20261108150000000_add-brand-shopify-sources.sql
-- Registers thirteen brand Shopify stores (brand sources plan, Task 10; the probe is in
-- docs/brand-sources-evaluation-2026-11.md). They are BRAND stores (no metadata.kind), images
-- allowed by default, never in SHOPIFY_RETAILER_SOURCES.
-- * Ten stores whose terms carry no automated-access clause are ENABLED like Night Owl (decision
--   D2, docs/decisions-2026-10.md): Deborah Lippmann, Londontown, Cote, Manucurist, Olive & June,
--   Piggy Paint, wet n wild, Alchemy Lacquers, Penelope Luz, Noodles Nail Polish.
-- * Mavala (terms page answered 500), CND (no terms page) and Barry M (terms page 404) are
--   registered DISABLED and PENDING until the owner reads their site terms or records the
--   store's written OK in metadata.notes (spec section 7). They are in
--   SHOPIFY_SOURCES_PENDING_APPROVAL, so code that reaches an environment first provisions them
--   disabled too.
-- Store filters (Task 11) live in src/lib/connectors/store-filters/. Keep in sync with
-- docs/seed_data_sources.sql.
--
-- The enabled rows are upserted, because new code auto-provisions any supported Shopify source
-- (createDataSourceIfMissing in src/lib/ingestion-repo.ts) and may run before this migration.
-- Rollback safety (the #394 / #398 pattern):
-- * a row this migration INSERTS is stamped metadata.insertedByMigration; the ON CONFLICT
--   branch strips that key from EXCLUDED.metadata, so a pre-existing row is never marked;
-- * a pre-existing row that was disabled is enabled and stamped metadata.enabledByMigration;
--   one that was already enabled is left enabled (currency, notes and verification merged in);
-- * the pending rows are insert only (ON CONFLICT DO NOTHING): an existing row is never changed,
--   enabled or disabled;
-- * the Down section deletes only a marked row without ingestion history, disables a marked row
--   that has history, re-disables the rows it enabled, and never touches anything else.

BEGIN;

INSERT INTO data_source (name, source_type, base_url, license, terms_url, enabled, metadata)
VALUES
  (
    'DeborahLippmannShopify',
    'api',
    'https://deborahlippmann.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://deborahlippmann.com/policies/terms-of-service',
    true,
    '{"currency": "USD", "priority": "medium", "mvp": "no", "notes": "Deborah Lippmann Shopify store (US, USD). Verified 2026-11-08: /products.json returns 200 with Shopify products (54: Nail Polish 25, Set 14, Treatment 7, Tools 5). The generic connector polish filter applies unchanged; sets are dropped by the set rule. Terms (6,300 characters) carry no automated-access clause. robots.txt does not disallow products.json. Registered as a brand store (no metadata.kind). Enabled 2026-11-08 under decision D2 (no automated-access clause); the store''s written OK has not been requested.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "products": 54, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": false}, "insertedByMigration": "20261108150000000"}'::jsonb
  ),
  (
    'LondontownShopify',
    'api',
    'https://londontownusa.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://londontownusa.com/policies/terms-of-service',
    true,
    '{"currency": "USD", "priority": "medium", "mvp": "no", "notes": "Londontown Shopify store (US, USD). Verified 2026-11-08: /products.json returns 200 with Shopify products (250+ over several pages; first page: Nail Color 68, Gels 65, Sets 39, Nail Care 30, Tools 27). Needs a store filter (connectors/store-filters, Task 11) to keep Nail Color and drop gels, sets and care. Terms carry no automated-access clause. robots.txt does not disallow products.json. Registered as a brand store (no metadata.kind). Enabled 2026-11-08 under decision D2 (no automated-access clause); the store''s written OK has not been requested.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "firstPageProducts": 250, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": false}, "insertedByMigration": "20261108150000000"}'::jsonb
  ),
  (
    'CoteShopify',
    'api',
    'https://coteshop.co',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://coteshop.co/policies/terms-of-service',
    true,
    '{"currency": "USD", "priority": "medium", "mvp": "no", "notes": "Cote Shopify store (US, USD). Verified 2026-11-08: /products.json returns 200 with Shopify products (129: Nail Polishes 66, gift set 11, lip shine 9, treatment 8, body 8). The generic connector polish filter applies unchanged. Terms carry no automated-access clause. robots.txt does not disallow products.json. Registered as a brand store (no metadata.kind). Enabled 2026-11-08 under decision D2 (no automated-access clause); the store''s written OK has not been requested.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "products": 129, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": false}, "insertedByMigration": "20261108150000000"}'::jsonb
  ),
  (
    'ManucuristShopify',
    'api',
    'https://manucurist.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://manucurist.com/policies/terms-of-service',
    true,
    '{"currency": "EUR", "priority": "medium", "mvp": "no", "notes": "Manucurist Shopify store (France, EUR). Verified 2026-11-08: /products.json returns 200 with Shopify products (250+; first page: product_type Vernis a ongles Green 68, Semi-permanent LED Green Flash 59, Soins 36, French product_type values). Needs a store filter (Task 11) for the French types. Terms carry no automated-access clause. robots.txt does not disallow products.json. Registered as a brand store (no metadata.kind). Enabled 2026-11-08 under decision D2 (no automated-access clause); the store''s written OK has not been requested.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "firstPageProducts": 250, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": false}, "insertedByMigration": "20261108150000000"}'::jsonb
  ),
  (
    'OliveAndJuneShopify',
    'api',
    'https://oliveandjune.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://oliveandjune.com/policies/terms-of-service',
    true,
    '{"currency": "USD", "priority": "medium", "mvp": "no", "notes": "Olive & June Shopify store (US, USD). Verified 2026-11-08: /products.json returns 200 with Shopify products (250+; first page: Press-On 51, Tab Press-On 30, Nail Polish 28, Pressies 22, Gel Polish 20, Dip). Needs a store filter (Task 11) to keep Nail Polish and drop press-ons, gel and dip. Terms carry no automated-access clause. robots.txt does not disallow products.json. Registered as a brand store (no metadata.kind). Enabled 2026-11-08 under decision D2 (no automated-access clause); the store''s written OK has not been requested.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "firstPageProducts": 250, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": false}, "insertedByMigration": "20261108150000000"}'::jsonb
  ),
  (
    'PiggyPaintShopify',
    'api',
    'https://piggypaint.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://piggypaint.com/policies/terms-of-service',
    true,
    '{"currency": "USD", "priority": "medium", "mvp": "no", "notes": "Piggy Paint Shopify store (US, USD). Verified 2026-11-08: /products.json returns 200 with Shopify products (250+; first page: empty product_type 110, Nail Art Kits & Accessories 92, Nail Polishes 24, Wholesale 12). Needs a store filter (Task 11) for the empty types. Terms carry no automated-access clause. robots.txt does not disallow products.json. Registered as a brand store (no metadata.kind). Enabled 2026-11-08 under decision D2 (no automated-access clause); the store''s written OK has not been requested.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "firstPageProducts": 250, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": false}, "insertedByMigration": "20261108150000000"}'::jsonb
  ),
  (
    'WetNWildShopify',
    'api',
    'https://wetnwildbeauty.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://wetnwildbeauty.com/policies/terms-of-service',
    true,
    '{"currency": "USD", "priority": "medium", "mvp": "no", "notes": "wet n wild Shopify store (US, USD). Verified 2026-11-08: /products.json returns 200 with Shopify products (250+ cosmetics; polish is not on page 1). Needs a store filter (Task 11) on title/type Nail Color. Terms carry no automated-access clause. robots.txt does not disallow products.json. Registered as a brand store (no metadata.kind). Enabled 2026-11-08 under decision D2 (no automated-access clause); the store''s written OK has not been requested.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "firstPageProducts": 250, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": false}, "insertedByMigration": "20261108150000000"}'::jsonb
  ),
  (
    'AlchemyLacquersShopify',
    'api',
    'https://alchemylacquers.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://alchemylacquers.com/policies/terms-of-service',
    true,
    '{"currency": "USD", "priority": "medium", "mvp": "no", "notes": "Alchemy Lacquers Shopify store (US indie, USD). Verified 2026-11-08: /products.json returns 200 with Shopify products (228: Nail Lacquer 198, empty product_type 30). The generic connector polish filter applies unchanged. Terms (2,100 characters) carry no automated-access clause. robots.txt does not disallow products.json. Registered as a brand store (no metadata.kind). Enabled 2026-11-08 under decision D2 (no automated-access clause); the store''s written OK has not been requested.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "products": 228, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": false}, "insertedByMigration": "20261108150000000"}'::jsonb
  ),
  (
    'PenelopeLuzShopify',
    'api',
    'https://penelopeluz.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://penelopeluz.com/policies/terms-of-service',
    true,
    '{"currency": "USD", "priority": "medium", "mvp": "no", "notes": "Penelope Luz Shopify store (US indie, USD). Verified 2026-11-08: /products.json returns 200 with Shopify products (216; product_type is empty on all). Needs a store filter (Task 11). Terms (2,000 characters) carry no automated-access clause. robots.txt does not disallow products.json. Registered as a brand store (no metadata.kind). Enabled 2026-11-08 under decision D2 (no automated-access clause); the store''s written OK has not been requested.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "products": 216, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": false}, "insertedByMigration": "20261108150000000"}'::jsonb
  ),
  (
    'NoodlesNailPolishShopify',
    'api',
    'https://noodlesnailpolish.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://noodlesnailpolish.com/policies/terms-of-service',
    true,
    '{"currency": "USD", "priority": "medium", "mvp": "no", "notes": "Noodles Nail Polish Shopify store (US indie, USD). Verified 2026-11-08: /products.json returns 200 with Shopify products (57; product_type is empty). Needs a store filter (Task 11). Terms (600 characters) carry no automated-access clause. robots.txt does not disallow products.json. Registered as a brand store (no metadata.kind). Enabled 2026-11-08 under decision D2 (no automated-access clause); the store''s written OK has not been requested.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "products": 57, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": false}, "insertedByMigration": "20261108150000000"}'::jsonb
  )
ON CONFLICT (name) DO UPDATE
SET
  base_url  = EXCLUDED.base_url,
  license   = EXCLUDED.license,
  terms_url = EXCLUDED.terms_url,
  enabled   = true,
  -- Existing keys (metadata.ingestion settings, an operator's own keys such as imagesPermitted)
  -- survive; currency and the survey facts come from this migration. A pre-existing row is
  -- never marked as inserted; one that was disabled is marked as enabled here.
  metadata  = (
      (COALESCE(data_source.metadata, '{}'::jsonb) || (EXCLUDED.metadata - 'insertedByMigration'))
      - 'pendingApproval'
    )
    || CASE
         WHEN data_source.enabled THEN '{}'::jsonb
         ELSE '{"enabledByMigration": "20261108150000000"}'::jsonb
       END;

INSERT INTO data_source (name, source_type, base_url, license, terms_url, enabled, metadata)
VALUES
  (
    'MavalaShopify',
    'api',
    'https://mavala.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://mavala.com/policies/terms-of-service',
    false,
    '{"currency": "CHF", "priority": "medium", "mvp": "no", "pendingApproval": true, "notes": "Mavala Shopify store (Switzerland, CHF). Verified 2026-11-08: /products.json returns 200 with Shopify products (150: Nail Care 34, Skincare 27, Make-Up 26, Instruments 19, Nail Polish 19). The generic connector polish filter applies unchanged. The terms page answered HTTP 500 on 2026-11-08, so the terms are unknown. robots.txt does not disallow products.json. REGISTERED DISABLED AND PENDING: the terms page answered HTTP 500, so whether automated access is allowed is unknown. The owner reads the site terms (or gets the store''s written OK) and records it here as ''Acceptable use confirmed by <name, role> at Mavala on <date> via <channel>: <summary>'', then sets enabled = true and removes pendingApproval.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "products": 150, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": null}, "insertedByMigration": "20261108150000000"}'::jsonb
  ),
  (
    'CndShopify',
    'api',
    'https://cnd.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://cnd.com/policies/terms-of-service',
    false,
    '{"currency": "USD", "priority": "medium", "mvp": "no", "pendingApproval": true, "notes": "CND Shopify store (US, Vinylux and Shellac, USD). Verified 2026-11-08: /products.json returns 200 with Shopify products (117: empty product_type 111, Gel Polish 6). Needs a store filter (Task 11) for the empty types. There is no terms page at /policies/terms-of-service (404). robots.txt does not disallow products.json. REGISTERED DISABLED AND PENDING: there is no terms page at the Shopify path, so whether automated access is allowed is unknown. The owner reads the site terms (or gets the store''s written OK) and records it here as ''Acceptable use confirmed by <name, role> at CND on <date> via <channel>: <summary>'', then sets enabled = true and removes pendingApproval.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "products": 117, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": null}, "insertedByMigration": "20261108150000000"}'::jsonb
  ),
  (
    'BarryMShopify',
    'api',
    'https://barrym.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://barrym.com/policies/terms-of-service',
    false,
    '{"currency": "GBP", "priority": "medium", "mvp": "no", "pendingApproval": true, "notes": "Barry M Shopify store (UK, GBP). Verified 2026-11-08: /products.json returns 200 with Shopify products (250+; first page: Nail Paint 106, plus lip and eye cosmetics). Needs a store filter (Task 11); Nail Paint is the polish signal. The terms page at the Shopify path is a 404. robots.txt does not disallow products.json. REGISTERED DISABLED AND PENDING: the terms page at the Shopify path is a 404, so whether automated access is allowed is unknown. The owner reads the site terms (or gets the store''s written OK) and records it here as ''Acceptable use confirmed by <name, role> at Barry M on <date> via <channel>: <summary>'', then sets enabled = true and removes pendingApproval.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "firstPageProducts": 250, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": null}, "insertedByMigration": "20261108150000000"}'::jsonb
  )
ON CONFLICT (name) DO NOTHING;

COMMIT;


-- Down Migration
-- Reverse only what Up did: re-disable the rows Up enabled (their notes are kept), and remove the
-- rows Up inserted unless something already ran against them (ingestion_job and external_product
-- cascade on delete, so a row with history is left in place, disabled). A row that existed before
-- and was already enabled, or an existing pending row, is not touched.
BEGIN;

UPDATE data_source
SET enabled = false,
    metadata = metadata - 'enabledByMigration'
WHERE name IN ('DeborahLippmannShopify', 'LondontownShopify', 'CoteShopify', 'ManucuristShopify', 'OliveAndJuneShopify', 'PiggyPaintShopify', 'WetNWildShopify', 'AlchemyLacquersShopify', 'PenelopeLuzShopify', 'NoodlesNailPolishShopify')
  AND metadata->>'enabledByMigration' = '20261108150000000';

UPDATE data_source
SET enabled = false
WHERE name IN ('DeborahLippmannShopify', 'LondontownShopify', 'CoteShopify', 'ManucuristShopify', 'OliveAndJuneShopify', 'PiggyPaintShopify', 'WetNWildShopify', 'AlchemyLacquersShopify', 'PenelopeLuzShopify', 'NoodlesNailPolishShopify', 'MavalaShopify', 'CndShopify', 'BarryMShopify')
  AND metadata->>'insertedByMigration' = '20261108150000000';

DELETE FROM data_source AS ds
WHERE ds.name IN ('DeborahLippmannShopify', 'LondontownShopify', 'CoteShopify', 'ManucuristShopify', 'OliveAndJuneShopify', 'PiggyPaintShopify', 'WetNWildShopify', 'AlchemyLacquersShopify', 'PenelopeLuzShopify', 'NoodlesNailPolishShopify', 'MavalaShopify', 'CndShopify', 'BarryMShopify')
  AND ds.metadata->>'insertedByMigration' = '20261108150000000'
  AND NOT EXISTS (SELECT 1 FROM ingestion_job j WHERE j.data_source_id = ds.data_source_id)
  AND NOT EXISTS (SELECT 1 FROM external_product e WHERE e.data_source_id = ds.data_source_id);

COMMIT;
