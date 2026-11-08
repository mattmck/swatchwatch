-- Up Migration

-- 20261108120000000_add-harlow-and-co-source.sql
-- Registers Harlow & Co (harlowandco.org, Canadian multi-brand retailer) ENABLED as a retailer
-- source (metadata.kind = 'retailer'; brand sources plan, Task 6). Its own terms carry no
-- automated-access clause, so under decision D2 (docs/decisions-2026-10.md) it needs no written
-- OK; the probe facts are in metadata.notes / metadata.verification. imagesPermitted is left
-- unset (false for a retailer): images stay off until the owner records the store's OK.
-- Store filter: src/lib/connectors/store-filters/harlow-and-co.ts. Keep in sync with
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
    'HarlowAndCoShopify',
    'api',
    'https://www.harlowandco.org',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://www.harlowandco.org/policies/terms-of-service',
    true,
    '{"kind": "retailer", "currency": "CAD", "vendorAliases": {"Cirque": "Cirque Colors", "piCture pOlish": "Picture Polish"}, "priority": "medium", "mvp": "no", "notes": "Harlow & Co Shopify store (Canadian multi-brand retailer, CAD). Verified 2026-11-08: /products.json returns 200 with Shopify products (1,537 over 7 pages, 22 vendors). Polish is typed Nail Polish / Nail Polishes (ILNP 605, KBShimmer 260, Cirque 238, Color Club, Polished for Days, Emily de Molly, I Scream Nails); the rest is other vendors'' decals, stamping plates, scrubs, oils, lotions, magnets and apparel. The store-specific filter connectors/store-filters/harlow-and-co.ts drops the non-polish product types and vendors and set-titled listings; with the retailer gate it accepts 1,282 of 1,537. robots.txt is the Shopify default (products.json not disallowed). The store''s own terms carry no automated-access clause. Registered as a retailer (metadata.kind = retailer): listings adopt the brand stores'' shades and only fill empty data; images stay off until metadata.imagesPermitted is set after the store''s OK. Enabled 2026-11-08.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "products": 1537, "vendors": 22, "storeFilterPass": 1282, "storeFilterCheckedAt": "2026-11-08", "robotsTxt": "shopify-default-allows-products-json", "termsScrapingClause": false}, "insertedByMigration": "20261108120000000"}'::jsonb
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
         ELSE '{"enabledByMigration": "20261108120000000"}'::jsonb
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
WHERE name = 'HarlowAndCoShopify'
  AND metadata->>'enabledByMigration' = '20261108120000000';

UPDATE data_source
SET enabled = false
WHERE name = 'HarlowAndCoShopify'
  AND metadata->>'insertedByMigration' = '20261108120000000';

DELETE FROM data_source AS ds
WHERE ds.name = 'HarlowAndCoShopify'
  AND ds.metadata->>'insertedByMigration' = '20261108120000000'
  AND NOT EXISTS (SELECT 1 FROM ingestion_job j WHERE j.data_source_id = ds.data_source_id)
  AND NOT EXISTS (SELECT 1 FROM external_product e WHERE e.data_source_id = ds.data_source_id);

COMMIT;
