-- Up Migration

-- 20261023021845964_add-approved-indie-shopify-sources.sql
-- Batch 3 of the indie Shopify stores for the generic Shopify connector (#273): registers
-- Stella Chroma, Lemming Lacquer and Sweet & Sour Lacquer ENABLED, and enables Night Owl
-- Lacquer where its row is still pending.
--
-- The three new stores use Shopify's default terms template (prohibited uses include
-- spider, crawl, or scrape), so under decision D2 (docs/decisions-2026-10.md) each is added
-- only with the store's written OK. The owner received written permission from each store
-- by email on 2026-10-22; metadata.notes records that with the terms URL
-- (docs/indie-sources-2026-10.md, batch 3). Each store has a store-specific product filter
-- (src/lib/connectors/store-filters/). Keep in sync with docs/seed_data_sources.sql.
--
-- Upserted, because new code auto-provisions any supported Shopify source
-- (createDataSourceIfMissing in src/lib/ingestion-repo.ts) and may run before this
-- migration. Rollback safety (the #394 / #398 pattern, built in from the start):
-- * a row this migration INSERTS is stamped metadata.insertedByMigration; the ON CONFLICT
--   branch strips that key from EXCLUDED.metadata, so a pre-existing row is never marked;
-- * a pre-existing row that was disabled is enabled and stamped metadata.enabledByMigration;
--   one that was already enabled is left enabled (notes and verification merged in);
-- * the Down section deletes only marked rows without ingestion history, disables marked rows
--   that have history, re-disables the rows it enabled, and never touches anything else.
--
-- Night Owl Lacquer: approved on 2026-10-17 (D2) and seeded enabled since, but migration
-- 20261017062550000_add-indie-shopify-sources inserted its row disabled with
-- metadata.pendingApproval and no later migration enabled it (the README asked each
-- environment to run the activation UPDATE by hand). This migration does that once, only for
-- a row still pending, the way 20261019020000000_enable-signed-off-indie-sources did for
-- Pahlish, Emily de Molly and Cirque Colors.

BEGIN;

INSERT INTO data_source (name, source_type, base_url, license, terms_url, enabled, metadata)
VALUES
  (
    'StellaChromaShopify',
    'api',
    'https://stellachroma.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://www.stellachroma.com/policies/terms-of-service',
    true,
    '{"priority": "medium", "mvp": "no", "insertedByMigration": "20261023021845964", "notes": "Stella Chroma Shopify store (indie, US). Verified 2026-10-22: /products.json returns 200 with Shopify products (81, one page; product_type Nail Polishes 38, Nail Polish 31, Nail Care 5, Shirts 1, Gift Card 1, empty or processing 5; vendor STELLA CHROMA). The generic connector polish filter accepts 72 of 81 but keeps two collection sets, the coat duo, the mystery grab bag and the mystery subscription and drops the cuticle oil; the store-specific filter connectors/store-filters/stella-chroma.ts fixes those and accepts 68 (63 single shades, 2 top coats, 1 base coat, 2 treatments). robots.txt is the Shopify default (products.json not disallowed). /policies/terms-of-service is the Shopify default template, whose prohibited uses include: spider, crawl, or scrape. Acceptable use confirmed: written permission received by the owner by email on 2026-10-22 (recorded in docs/indie-sources-2026-10.md). Enabled 2026-10-22.", "verification": {"checkedAt": "2026-10-22", "productsJson": true, "products": 81, "polishFilterPass": 72, "storeFilterPass": 68, "storeFilterCheckedAt": "2026-10-22", "robotsTxt": "shopify-default-allows-products-json", "termsScrapingClause": true, "writtenPermission": "email 2026-10-22"}}'::jsonb
  ),
  (
    'LemmingLacquerShopify',
    'api',
    'https://lemminglacquer.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://lemminglacquer.com/policies/terms-of-service',
    true,
    '{"priority": "medium", "mvp": "no", "insertedByMigration": "20261023021845964", "notes": "Lemming Lacquer Shopify store (indie, US). Verified 2026-10-22: /products.json returns 200 with Shopify products (30, one page; product_type Nail Polishes 23, Collection 3, Multichrome 1, Flakes 1, Acessories 1, empty 1). The generic connector polish filter accepts 24 of 30 but drops the Multichrome-typed shade and keeps the Polish Pickup mystery grab bag; the store-specific filter connectors/store-filters/lemming-lacquer.ts fixes both and accepts 24 single shades (collection listings, gift card, magnet and mysteries dropped). robots.txt is the Shopify default (products.json not disallowed). /policies/terms-of-service is the Shopify default template, whose prohibited uses include: spider, crawl, or scrape. Acceptable use confirmed: written permission received by the owner by email on 2026-10-22 (recorded in docs/indie-sources-2026-10.md). Enabled 2026-10-22.", "verification": {"checkedAt": "2026-10-22", "productsJson": true, "products": 30, "polishFilterPass": 24, "storeFilterPass": 24, "storeFilterCheckedAt": "2026-10-22", "robotsTxt": "shopify-default-allows-products-json", "termsScrapingClause": true, "writtenPermission": "email 2026-10-22"}}'::jsonb
  ),
  (
    'SweetAndSourLacquerShopify',
    'api',
    'https://sweetandsourlacquer.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://sweetandsourlacquer.com/policies/terms-of-service',
    true,
    '{"priority": "medium", "mvp": "no", "insertedByMigration": "20261023021845964", "notes": "Sweet & Sour Lacquer Shopify store (indie, US). Verified 2026-10-22: /products.json returns 200 with Shopify products (169, one page; product_type and tags are empty on every product). The generic connector polish filter accepts 8 of 169 (coats and coat refills by title); the store-specific filter connectors/store-filters/sweet-and-sour.ts accepts 155 (150 single shades, 4 base coats, 1 top coat) by title and description, dropping the trio, duo, mystery overpour, 4 coat refills, gift card, magnet, sticker, coozies, tab opener, the clear watermarbling polish and one listing with no description beyond a restock note. robots.txt is the Shopify default (products.json not disallowed). /policies/terms-of-service is the Shopify default template, whose prohibited uses include: spider, crawl, or scrape. Acceptable use confirmed: written permission received by the owner by email on 2026-10-22 (recorded in docs/indie-sources-2026-10.md). Enabled 2026-10-22.", "verification": {"checkedAt": "2026-10-22", "productsJson": true, "products": 169, "polishFilterPass": 8, "storeFilterPass": 155, "storeFilterCheckedAt": "2026-10-22", "robotsTxt": "shopify-default-allows-products-json", "termsScrapingClause": true, "writtenPermission": "email 2026-10-22"}}'::jsonb
  )
ON CONFLICT (name) DO UPDATE
SET
  base_url  = EXCLUDED.base_url,
  license   = EXCLUDED.license,
  terms_url = EXCLUDED.terms_url,
  enabled   = true,
  -- Existing keys (metadata.ingestion settings, an operator's own keys) survive; the survey
  -- facts and the approval note come from this migration. A pre-existing row is never
  -- marked as inserted; one that was disabled is marked as enabled here.
  metadata  = (
      (COALESCE(data_source.metadata, '{}'::jsonb) || (EXCLUDED.metadata - 'insertedByMigration'))
      - 'pendingApproval'
    )
    || CASE
         WHEN data_source.enabled THEN '{}'::jsonb
         ELSE '{"enabledByMigration": "20261023021845964"}'::jsonb
       END;

-- Night Owl Lacquer: enable the row where it is still pending (decision D2, 2026-10-17).
UPDATE data_source
SET enabled = true,
    metadata = (metadata - 'pendingApproval')
      || jsonb_build_object(
           'enabledByMigration', '20261023021845964',
           'notes',
           coalesce(metadata->>'notes', '')
           || ' Update 2026-10-22: enabled by migration 20261023021845964 on the owner decision of 2026-10-17 (docs/decisions-2026-10.md D2: the terms carry no automated-access clause); the earlier disabled-pending-approval wording above no longer applies.'
         )
WHERE name = 'NightOwlLacquerShopify'
  AND metadata->>'pendingApproval' = 'true';

COMMIT;


-- Down Migration
-- Reverse only what Up did: re-disable the rows it enabled (their notes are kept), and remove
-- the rows it inserted unless something already ran against them (ingestion_job and
-- external_product cascade on delete, so a row with history is left in place, disabled).
-- A row that existed before and was already enabled is not touched.
BEGIN;

UPDATE data_source
SET enabled = false,
    metadata = metadata - 'enabledByMigration'
WHERE name IN ('StellaChromaShopify', 'LemmingLacquerShopify', 'SweetAndSourLacquerShopify')
  AND metadata->>'enabledByMigration' = '20261023021845964';

UPDATE data_source
SET enabled = false
WHERE name IN ('StellaChromaShopify', 'LemmingLacquerShopify', 'SweetAndSourLacquerShopify')
  AND metadata->>'insertedByMigration' = '20261023021845964';

DELETE FROM data_source AS ds
WHERE ds.name IN ('StellaChromaShopify', 'LemmingLacquerShopify', 'SweetAndSourLacquerShopify')
  AND ds.metadata->>'insertedByMigration' = '20261023021845964'
  AND NOT EXISTS (SELECT 1 FROM ingestion_job j WHERE j.data_source_id = ds.data_source_id)
  AND NOT EXISTS (SELECT 1 FROM external_product e WHERE e.data_source_id = ds.data_source_id);

UPDATE data_source
SET enabled = false,
    metadata = (metadata - 'enabledByMigration') || '{"pendingApproval": true}'::jsonb
WHERE name = 'NightOwlLacquerShopify'
  AND metadata->>'enabledByMigration' = '20261023021845964';

COMMIT;
