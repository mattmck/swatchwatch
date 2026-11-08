-- Up Migration

-- 20261108190000000_add-big-cartel-sources.sql
-- Registers five Big Cartel brand stores for the Big Cartel connector (brand sources plan,
-- Task 17; lib/connectors/big-cartel.ts), all DISABLED AND PENDING: PaintedPolishBigCartel,
-- PotionPolishBigCartel, ColoresDeCarolBigCartel, GlistenAndGlowBigCartel and
-- PoetryCowgirlBigCartel. https://api.bigcartel.com/<subdomain>/products.json answered 200 for
-- each on 2026-11-08; the owner reads Big Cartel's API License Agreement (linked from
-- developers.bigcartel.com/api/v0) and each store's terms, then records the OK in metadata.notes
-- (spec section 7). Every row carries metadata.subdomain and metadata.brand (the connector
-- refuses a source without a brand). Not Shopify sources, so they are never auto-provisioned;
-- this migration is their only registration. Keep in sync with docs/seed_data_sources.sql.
--
-- PotionPolishShopify (disabled since the store left Shopify) gains "Superseded by
-- PotionPolishBigCartel." in its notes, once (guarded by name and by the note not being there),
-- stamped metadata.notesUpdatedByMigration so Down can take exactly that sentence back out. Its
-- enabled flag and every other key are left alone.
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
    'PaintedPolishBigCartel',
    'api',
    'https://paintedpolish.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    NULL,
    false,
    '{"brand": "Painted Polish", "subdomain": "paintedpolish", "priority": "medium", "mvp": "no", "pendingApproval": true, "notes": "Painted Polish brand store on Big Cartel, read through the Big Cartel v0 API (BigCartel connector, brand sources plan Task 17). Painted Polish''s own domain answered 404 for /products.json on 2026-11-08 and sits behind Cloudflare; the v0 API answers under the subdomain paintedpolish. Verified 2026-11-08: https://api.bigcartel.com/paintedpolish/products.json answered 200 with 287 products (135 active, 152 sold-out); the shared connector gate (categories as product type and tags) keeps 47 of them, so a store filter may be needed before enabling. The store currency comes from the API''s store.json at ingest time. Terms: not read yet. REGISTERED DISABLED AND PENDING: the owner reads Big Cartel''s API License Agreement (linked from developers.bigcartel.com/api/v0) and the store''s terms and asks for the OK, records it here as ''Acceptable use confirmed by <name, role> at Painted Polish on <date> via <channel>: <summary>'', then sets enabled = true and removes pendingApproval.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "productsJsonUrl": "https://api.bigcartel.com/paintedpolish/products.json", "products": 287, "connectorGatePass": 47, "storeJson": null, "termsScrapingClause": null}, "insertedByMigration": "20261108190000000"}'::jsonb
  ),
  (
    'PotionPolishBigCartel',
    'api',
    'https://www.potionpolish.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    NULL,
    false,
    '{"brand": "Potion Polish", "subdomain": "potionpolish", "priority": "medium", "mvp": "no", "pendingApproval": true, "notes": "Potion Polish brand store on Big Cartel, read through the Big Cartel v0 API (BigCartel connector, brand sources plan Task 17). Replaces the disabled PotionPolishShopify row (the store moved from Shopify to Big Cartel). Verified 2026-11-08: https://api.bigcartel.com/potionpolish/products.json answered 200 with 35 products (33 active, 2 sold-out); the shared connector gate (categories as product type and tags) keeps 0 of them, so a store filter may be needed before enabling. The store currency comes from the API''s store.json at ingest time. Terms: not read yet. REGISTERED DISABLED AND PENDING: the owner reads Big Cartel''s API License Agreement (linked from developers.bigcartel.com/api/v0) and the store''s terms and asks for the OK, records it here as ''Acceptable use confirmed by <name, role> at Potion Polish on <date> via <channel>: <summary>'', then sets enabled = true and removes pendingApproval.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "productsJsonUrl": "https://api.bigcartel.com/potionpolish/products.json", "products": 35, "connectorGatePass": 0, "storeJson": null, "termsScrapingClause": null}, "insertedByMigration": "20261108190000000"}'::jsonb
  ),
  (
    'ColoresDeCarolBigCartel',
    'api',
    'https://coloresdecarol.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    NULL,
    false,
    '{"brand": "Colores de Carol", "subdomain": "coloresdecarol", "priority": "medium", "mvp": "no", "pendingApproval": true, "notes": "Colores de Carol brand store on Big Cartel, read through the Big Cartel v0 API (BigCartel connector, brand sources plan Task 17). The store''s own domain sits behind Cloudflare; the v0 API answers under the subdomain coloresdecarol. Verified 2026-11-08: https://api.bigcartel.com/coloresdecarol/products.json answered 200 with 265 products (223 active, 42 sold-out); the shared connector gate (categories as product type and tags) keeps 223 of them, so a store filter may be needed before enabling. The store currency comes from the API''s store.json at ingest time. Terms: not read yet. REGISTERED DISABLED AND PENDING: the owner reads Big Cartel''s API License Agreement (linked from developers.bigcartel.com/api/v0) and the store''s terms and asks for the OK, records it here as ''Acceptable use confirmed by <name, role> at Colores de Carol on <date> via <channel>: <summary>'', then sets enabled = true and removes pendingApproval.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "productsJsonUrl": "https://api.bigcartel.com/coloresdecarol/products.json", "products": 265, "connectorGatePass": 223, "storeJson": null, "termsScrapingClause": null}, "insertedByMigration": "20261108190000000"}'::jsonb
  ),
  (
    'GlistenAndGlowBigCartel',
    'api',
    'https://glistenandglow.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    NULL,
    false,
    '{"brand": "Glisten & Glow", "subdomain": "glistenandglow", "priority": "medium", "mvp": "no", "pendingApproval": true, "notes": "Glisten & Glow brand store on Big Cartel, read through the Big Cartel v0 API (BigCartel connector, brand sources plan Task 17). Verified 2026-11-08: https://api.bigcartel.com/glistenandglow/products.json answered 200 with 278 products (278 active); the shared connector gate (categories as product type and tags) keeps 99 of them, so a store filter may be needed before enabling. The store currency comes from the API''s store.json at ingest time. Terms: not read yet. REGISTERED DISABLED AND PENDING: the owner reads Big Cartel''s API License Agreement (linked from developers.bigcartel.com/api/v0) and the store''s terms and asks for the OK, records it here as ''Acceptable use confirmed by <name, role> at Glisten & Glow on <date> via <channel>: <summary>'', then sets enabled = true and removes pendingApproval.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "productsJsonUrl": "https://api.bigcartel.com/glistenandglow/products.json", "products": 278, "connectorGatePass": 99, "storeJson": null, "termsScrapingClause": null}, "insertedByMigration": "20261108190000000"}'::jsonb
  ),
  (
    'PoetryCowgirlBigCartel',
    'api',
    'https://poetrycowgirlnailpolish.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    NULL,
    false,
    '{"brand": "Poetry Cowgirl Nail Polish", "subdomain": "poetrycowgirlnailpolish", "priority": "low", "mvp": "no", "pendingApproval": true, "notes": "Poetry Cowgirl Nail Polish brand store on Big Cartel, read through the Big Cartel v0 API (BigCartel connector, brand sources plan Task 17). Verified 2026-11-08: https://api.bigcartel.com/poetrycowgirlnailpolish/products.json answered 200 with 207 products (132 active, 75 sold-out); the shared connector gate (categories as product type and tags) keeps 9 of them, so a store filter may be needed before enabling. The store currency comes from the API''s store.json at ingest time. Terms: not read yet. REGISTERED DISABLED AND PENDING: the owner reads Big Cartel''s API License Agreement (linked from developers.bigcartel.com/api/v0) and the store''s terms and asks for the OK, records it here as ''Acceptable use confirmed by <name, role> at Poetry Cowgirl Nail Polish on <date> via <channel>: <summary>'', then sets enabled = true and removes pendingApproval.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "productsJsonUrl": "https://api.bigcartel.com/poetrycowgirlnailpolish/products.json", "products": 207, "connectorGatePass": 9, "storeJson": null, "termsScrapingClause": null}, "insertedByMigration": "20261108190000000"}'::jsonb
  )

ON CONFLICT (name) DO NOTHING;

UPDATE data_source
SET metadata = jsonb_set(
      metadata,
      '{notes}',
      to_jsonb(rtrim(COALESCE(metadata->>'notes', '')) || ' Superseded by PotionPolishBigCartel.')
    ) || '{"notesUpdatedByMigration": "20261108190000000"}'::jsonb
WHERE name = 'PotionPolishShopify'
  AND COALESCE(metadata->>'notes', '') NOT LIKE '%Superseded by PotionPolishBigCartel%';

COMMIT;

-- Down Migration
-- Remove the rows Up inserted unless something already ran against them (ingestion_job and
-- external_product cascade on delete, so a row with history is left in place, disabled), and take
-- the PotionPolishShopify sentence back out only where this migration added it.
BEGIN;

UPDATE data_source
SET enabled = false
WHERE name IN ('PaintedPolishBigCartel', 'PotionPolishBigCartel', 'ColoresDeCarolBigCartel', 'GlistenAndGlowBigCartel', 'PoetryCowgirlBigCartel')
  AND metadata->>'insertedByMigration' = '20261108190000000';

DELETE FROM data_source AS ds
WHERE ds.name IN ('PaintedPolishBigCartel', 'PotionPolishBigCartel', 'ColoresDeCarolBigCartel', 'GlistenAndGlowBigCartel', 'PoetryCowgirlBigCartel')
  AND ds.metadata->>'insertedByMigration' = '20261108190000000'
  AND NOT EXISTS (SELECT 1 FROM ingestion_job j WHERE j.data_source_id = ds.data_source_id)
  AND NOT EXISTS (SELECT 1 FROM external_product e WHERE e.data_source_id = ds.data_source_id);

UPDATE data_source
SET metadata = jsonb_set(
      metadata - 'notesUpdatedByMigration',
      '{notes}',
      to_jsonb(replace(metadata->>'notes', ' Superseded by PotionPolishBigCartel.', ''))
    )
WHERE name = 'PotionPolishShopify'
  AND metadata->>'notesUpdatedByMigration' = '20261108190000000';

COMMIT;
