-- Up Migration

-- 20261113120000000_add-swamp-gloss-source.sql
-- Registers the Swamp Gloss brand Shopify store (swampgloss.com), photographed in the 2026-11 bottle
-- eval with no source. A BRAND store (no metadata.kind), images allowed by default, never in
-- SHOPIFY_RETAILER_SOURCES. Its terms carry the Shopify template's "spider, crawl, or scrape" clause;
-- it is ENABLED on 2026-11-13 by the owner's decision without a store OK (as Picture Polish, Painted
-- Polish and Potion Polish were on 2026-11-10), and metadata.notes says so. Store filter and title
-- parser: src/lib/connectors/store-filters/swamp-gloss.ts. Keep in sync with docs/seed_data_sources.sql.
--
-- Upserted, because new code auto-provisions any supported Shopify source (createDataSourceIfMissing)
-- and may run before this migration. Rollback safety (the #394 / #398 pattern, as in
-- 20261108150000000_add-brand-shopify-sources.sql):
-- * a row this migration INSERTS is stamped metadata.insertedByMigration; the ON CONFLICT branch
--   strips that key, so a pre-existing row is never marked;
-- * a pre-existing disabled row is enabled and stamped metadata.enabledByMigration;
-- * Down re-disables what Up enabled and deletes an inserted row only when nothing ran against it.

BEGIN;

INSERT INTO data_source (name, source_type, base_url, license, terms_url, enabled, metadata)
VALUES
  (
    'SwampGlossShopify',
    'api',
    'https://swampgloss.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://swampgloss.com/policies/terms-of-service',
    true,
    '{"currency": "USD", "vendorAliases": {"swampgloss.com": "Swamp Gloss"}, "priority": "medium", "mvp": "no", "notes": "Swamp Gloss Shopify store (US indie, USD). Verified 2026-11-13: /products.json returns 200 with Shopify products (178 on one page: product_type empty 98, Cosmetics 27, Nail Polish 25, Nail Polishes 8, the rest body care, wax melts, perfume, stickers, tumblers and a gift card; vendor ''Swamp Gloss'' or ''swampgloss.com''). Store filter connectors/store-filters/swamp-gloss.ts keeps 139 (single shades and coats) and drops mystery and overpour listings, oops batches, trios, quads, refills, magnets, stickers and the non-polish types; the title parser drops a trailing charity note. robots.txt does not disallow products.json. The terms of service (Shopify template) forbid using the site to ''spider, crawl, or scrape''. Registered as a brand store (no metadata.kind). Enabled on 2026-11-13 by the owner''s decision without a store OK; ask the maker for the record.", "verification": {"checkedAt": "2026-11-13", "productsJson": true, "products": 178, "robotsTxt": "products-json-not-disallowed", "termsScrapingClause": true}, "insertedByMigration": "20261113120000000"}'::jsonb
  )
ON CONFLICT (name) DO UPDATE
SET
  base_url  = EXCLUDED.base_url,
  license   = EXCLUDED.license,
  terms_url = EXCLUDED.terms_url,
  enabled   = true,
  metadata  = (
      (COALESCE(data_source.metadata, '{}'::jsonb) || (EXCLUDED.metadata - 'insertedByMigration'))
      - 'pendingApproval'
    )
    || CASE
         WHEN data_source.enabled THEN '{}'::jsonb
         ELSE '{"enabledByMigration": "20261113120000000"}'::jsonb
       END;

COMMIT;


-- Down Migration
-- Reverse only what Up did: re-disable the row if Up enabled it, and remove the row Up inserted
-- unless something already ran against it (then it is left in place, disabled).
BEGIN;

UPDATE data_source
SET enabled = false,
    metadata = metadata - 'enabledByMigration'
WHERE name = 'SwampGlossShopify'
  AND metadata->>'enabledByMigration' = '20261113120000000';

UPDATE data_source
SET enabled = false
WHERE name = 'SwampGlossShopify'
  AND metadata->>'insertedByMigration' = '20261113120000000';

DELETE FROM data_source AS ds
WHERE ds.name = 'SwampGlossShopify'
  AND ds.metadata->>'insertedByMigration' = '20261113120000000'
  AND NOT EXISTS (SELECT 1 FROM ingestion_job j WHERE j.data_source_id = ds.data_source_id)
  AND NOT EXISTS (SELECT 1 FROM external_product e WHERE e.data_source_id = ds.data_source_id);

COMMIT;
