-- Up Migration

-- 20261108130000000_add-beyond-polish-source.sql
-- Registers Beyond Polish (beyondpolish.com, US multi-brand retailer) ENABLED as a retailer
-- source (metadata.kind = 'retailer'; brand sources plan, Task 7). Its own terms carry no
-- automated-access clause (only a sentence about harvesting other users' personal data), so under
-- decision D2 (docs/decisions-2026-10.md) it needs no written OK; the probe facts are in
-- metadata.notes / metadata.verification. imagesPermitted is left unset (false for a retailer):
-- images stay off until the owner records the store's OK. metadata.maxPages = 100 lets the
-- 71-page catalog be read to the end (the connector default is 30 pages).
-- Store filter: src/lib/connectors/store-filters/beyond-polish.ts. Keep in sync with
-- docs/seed_data_sources.sql.
--
-- Upserted, because new code auto-provisions any supported Shopify source
-- (createDataSourceIfMissing in src/lib/ingestion-repo.ts) and may run before this
-- migration. Rollback safety (the #394 / #398 pattern):
-- * a row this migration INSERTS is stamped metadata.insertedByMigration; the ON CONFLICT
--   branch strips that key from EXCLUDED.metadata, so a pre-existing row is never marked;
-- * a pre-existing row that was disabled is enabled and stamped metadata.enabledByMigration;
--   one that was already enabled is left enabled (kind, aliases, notes and verification merged in);
-- * the Down section deletes only a marked row without ingestion history, disables a marked row
--   that has history, re-disables the row it enabled, and never touches anything else.

BEGIN;

INSERT INTO data_source (name, source_type, base_url, license, terms_url, enabled, metadata)
VALUES
  (
    'BeyondPolishShopify',
    'api',
    'https://www.beyondpolish.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://www.beyondpolish.com/policies/terms-of-service',
    true,
    '{"kind": "retailer", "currency": "USD", "includeGel": false, "maxPages": 100, "vendorAliases": {"ORLY": "Orly", "Lippmann": "Deborah Lippmann", "Sunday Studio": "Sundays", "DND - Daisy Nail Design": "DND", "Harmony": "Gelish", "ella+mila": "Ella+Mila", "butter LONDON": "butter LONDON"}, "priority": "medium", "mvp": "no", "notes": "Beyond Polish Shopify store (US multi-brand retailer, USD). Verified 2026-11-08: /products.json returns 200 with Shopify products (17,508 over 71 pages of 250, 103 vendors). The store''s own terms carry no automated-access clause (only a sentence about harvesting other users'' personal data); robots.txt is the Shopify default (products.json not disallowed). The generic polish gate accepts 9,395 of the 17,508; the lacquer-typed products (product_type Nail Lacquer, Lacquer & Dip, Gel, Lacquer & Dip) accept 4,138 (OPI 1,160, Zoya 262, Orly 255, Cirque 244, KBShimmer 223, Morgan Taylor 205, CND 159, Ella+Mila 142, Londontown 141, Essie 118, China Glaze 102, Color Club 80, butter LONDON 66). The store-specific filter connectors/store-filters/beyond-polish.ts keeps only those lacquer types (Gel Polish too when metadata.includeGel is true) and drops Gel & Lacquer Polish combos, sets, kits, mystery boxes, hair, skin, jewellery, tools and the store''s own merchandise. Products.json carries no barcodes. Registered as a retailer (metadata.kind = retailer): listings adopt the brand stores'' shades and only fill empty data; images stay off until metadata.imagesPermitted is set after the store''s OK. maxPages 100 lets the 71-page catalog be read to the end. Enabled 2026-11-08.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "products": 17508, "vendors": 103, "genericGateAccepts": 9395, "lacquerTypedAccepts": 4138, "barcodesInProductsJson": false, "robotsTxt": "shopify-default-allows-products-json", "termsScrapingClause": false}, "insertedByMigration": "20261108130000000"}'::jsonb
  )
ON CONFLICT (name) DO UPDATE
SET
  base_url  = EXCLUDED.base_url,
  license   = EXCLUDED.license,
  terms_url = EXCLUDED.terms_url,
  enabled   = true,
  -- Existing keys (metadata.ingestion settings, an operator's own keys such as imagesPermitted)
  -- survive; kind, aliases and the survey facts come from this migration. A pre-existing row is
  -- never marked as inserted; one that was disabled is marked as enabled here.
  metadata  = (
      (COALESCE(data_source.metadata, '{}'::jsonb) || (EXCLUDED.metadata - 'insertedByMigration'))
      - 'pendingApproval'
    )
    || CASE
         WHEN data_source.enabled THEN '{}'::jsonb
         ELSE '{"enabledByMigration": "20261108130000000"}'::jsonb
       END;

COMMIT;


-- Down Migration
-- Reverse only what Up did: re-disable the row if Up enabled it (its notes are kept), and remove
-- the row if Up inserted it unless something already ran against it (ingestion_job and
-- external_product cascade on delete, so a row with history is left in place, disabled).
-- A row that existed before and was already enabled is not touched.
BEGIN;

UPDATE data_source
SET enabled = false,
    metadata = metadata - 'enabledByMigration'
WHERE name = 'BeyondPolishShopify'
  AND metadata->>'enabledByMigration' = '20261108130000000';

UPDATE data_source
SET enabled = false
WHERE name = 'BeyondPolishShopify'
  AND metadata->>'insertedByMigration' = '20261108130000000';

DELETE FROM data_source AS ds
WHERE ds.name = 'BeyondPolishShopify'
  AND ds.metadata->>'insertedByMigration' = '20261108130000000'
  AND NOT EXISTS (SELECT 1 FROM ingestion_job j WHERE j.data_source_id = ds.data_source_id)
  AND NOT EXISTS (SELECT 1 FROM external_product e WHERE e.data_source_id = ds.data_source_id);

COMMIT;
