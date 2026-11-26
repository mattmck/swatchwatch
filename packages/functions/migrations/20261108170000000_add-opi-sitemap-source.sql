-- Up Migration

-- 20261108170000000_add-opi-sitemap-source.sql
-- Registers OPI's brand store as a sitemap + JSON-LD source (brand sources plan, Task 15;
-- SitemapJsonLd connector, lib/connectors/sitemap-jsonld.ts): metadata.sitemapUrl, the two product
-- URL prefixes (nail lacquer, Infinite Shine) and brand "OPI". No terms page was found at
-- /terms-of-use on 2026-11-08, so it is registered DISABLED and PENDING until the owner reads
-- OPI's site terms and records the OK in metadata.notes (spec section 7). Not a Shopify source, so
-- it is never auto-provisioned; this migration is its only registration. Keep in sync with
-- docs/seed_data_sources.sql.
--
-- Rollback safety (the pending-row pattern of 20261108150000000): the row is insert only
-- (ON CONFLICT DO NOTHING), so an existing row is never changed, enabled or disabled; a row this
-- migration INSERTS is stamped metadata.insertedByMigration; the Down section deletes only a
-- stamped row without ingestion history, disables a stamped row that has history, and never
-- touches anything else.

BEGIN;

INSERT INTO data_source (name, source_type, base_url, license, terms_url, enabled, metadata)
VALUES
  (
    'OpiSitemap',
    'api',
    'https://www.opi.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    NULL,
    false,
    '{"brand": "OPI", "sitemapUrl": "https://www.opi.com/sitemap.xml", "productUrlPrefixes": ["https://www.opi.com/products/nail-lacquer-", "https://www.opi.com/products/infinite-shine-"], "currency": "USD", "priority": "medium", "mvp": "no", "pendingApproval": true, "notes": "OPI brand store (US, USD), read through its sitemap and product-page JSON-LD (SitemapJsonLd connector, brand sources plan Task 15). Verified 2026-11-08: https://www.opi.com/sitemap.xml is a <urlset> of 1,898 pages, 575 of them under the two product prefixes (nail-lacquer-, infinite-shine-); a product page carries one application/ld+json Product with gtin, sku, brand, images and offers. Terms: no terms page at /terms-of-use on 2026-11-08, so whether automated access is allowed is unknown. REGISTERED DISABLED AND PENDING: the owner locates and reads OPI''s site terms and asks for the OK, records it here as ''Acceptable use confirmed by <name, role> at OPI on <date> via <channel>: <summary>'', then sets enabled = true and removes pendingApproval. The crawl needs CONNECTOR_RAW_CONTAINER (a durable catalog cache).", "verification": {"checkedAt": "2026-11-08", "sitemap": true, "productUrls": "1898-page sitemap on 2026-11-08 (575 under the product prefixes)", "jsonLdProduct": true, "termsScrapingClause": null}, "insertedByMigration": "20261108170000000"}'::jsonb
  )
ON CONFLICT (name) DO NOTHING;

COMMIT;

-- Down Migration
-- Remove the row Up inserted unless something already ran against it (ingestion_job and
-- external_product cascade on delete, so a row with history is left in place, disabled).
BEGIN;

UPDATE data_source
SET enabled = false
WHERE name IN ('OpiSitemap')
  AND metadata->>'insertedByMigration' = '20261108170000000';

DELETE FROM data_source AS ds
WHERE ds.name IN ('OpiSitemap')
  AND ds.metadata->>'insertedByMigration' = '20261108170000000'
  AND NOT EXISTS (SELECT 1 FROM ingestion_job j WHERE j.data_source_id = ds.data_source_id)
  AND NOT EXISTS (SELECT 1 FROM external_product e WHERE e.data_source_id = ds.data_source_id);

COMMIT;
