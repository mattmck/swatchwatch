-- Up Migration

-- 20261108180000000_add-woocommerce-sources.sql
-- Registers three WooCommerce brand stores for the WooCommerce Store API connector (brand
-- sources plan, Task 16; lib/connectors/woocommerce-store.ts), all DISABLED:
-- - PicturePolishWooCommerce (AUD): the Store API answered 200 on 2026-11-08; the terms are not
--   read yet, so it is PENDING until the owner records the OK in metadata.notes (spec section 7).
-- - IlnpWooCommerce: metadata.blocked = "robots" (robots.txt disallows the Store API).
-- - KbshimmerWooCommerce: metadata.blocked = "cloudflare" (a Cloudflare challenge on every path).
--   The two blocked rows are registered so the admin console lists them as known-blocked.
-- Not Shopify sources, so they are never auto-provisioned; this migration is their only
-- registration. Keep in sync with docs/seed_data_sources.sql.
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
    'PicturePolishWooCommerce',
    'api',
    'https://picturepolish.com.au',
    'Storefront terms apply (verify metadata/image usage obligations)',
    NULL,
    false,
    '{"brand": "Picture Polish", "currency": "AUD", "priority": "medium", "mvp": "no", "pendingApproval": true, "notes": "Picture Polish brand store (Australia, AUD), read through the WooCommerce Store API (WooCommerce connector, brand sources plan Task 16). Verified 2026-11-08: https://picturepolish.com.au/wp-json/wc/store/v1/products answered 200 with WooCommerce Store API products. Terms: not read yet, so whether automated access is allowed is unknown. REGISTERED DISABLED AND PENDING: the owner reads the store''s terms and asks for the OK, records it here as ''Acceptable use confirmed by <name, role> at Picture Polish on <date> via <channel>: <summary>'', then sets enabled = true and removes pendingApproval. The connector checks robots.txt before any product request.", "verification": {"checkedAt": "2026-11-08", "storeApi": true, "robotsTxt": null, "termsScrapingClause": null}, "insertedByMigration": "20261108180000000"}'::jsonb
  ),
  (
    'IlnpWooCommerce',
    'api',
    'https://ilnp.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    NULL,
    false,
    '{"brand": "ILNP", "currency": "USD", "priority": "high", "mvp": "no", "pendingApproval": true, "blocked": "robots", "notes": "ILNP brand store (US, USD) on WooCommerce. KNOWN BLOCKED: its robots.txt disallows /wp-json/ and /wc/store/v1/ (October 2026 survey; the Store API itself answered 200), so the WooCommerce connector refuses to run it (WooCommerce Store API disallowed by robots.txt). Registered disabled so the admin console lists it as a known-blocked source; ILNP is reached through resellers instead (Harlow & Co, Hypnotic Polish; docs/brand-sources-evaluation-2026-11.md). Enable only with ILNP''s written OK recorded here as ''Acceptable use confirmed by <name, role> at ILNP on <date> via <channel>: <summary>'' and a robots.txt that allows the Store API.", "verification": {"checkedAt": "2026-11-08", "storeApi": true, "robotsTxt": "store-api-disallowed", "termsScrapingClause": null}, "insertedByMigration": "20261108180000000"}'::jsonb
  ),
  (
    'KbshimmerWooCommerce',
    'api',
    'https://kbshimmer.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    NULL,
    false,
    '{"brand": "KBShimmer", "currency": "USD", "priority": "high", "mvp": "no", "pendingApproval": true, "blocked": "cloudflare", "notes": "KBShimmer brand store (US, USD) on WordPress. KNOWN BLOCKED: every path answers a Cloudflare challenge (403) to automated requests (November 2026 probe), so the Store API cannot be read. Registered disabled so the admin console lists it as a known-blocked source; KBShimmer is reached through resellers instead (Harlow & Co, Beyond Polish; docs/brand-sources-evaluation-2026-11.md). Enable only with KBShimmer''s written OK recorded here as ''Acceptable use confirmed by <name, role> at KBShimmer on <date> via <channel>: <summary>'' and access that does not hit the challenge.", "verification": {"checkedAt": "2026-11-08", "storeApi": false, "cloudflareChallenge": true, "termsScrapingClause": null}, "insertedByMigration": "20261108180000000"}'::jsonb
  )
ON CONFLICT (name) DO NOTHING;

COMMIT;

-- Down Migration
-- Remove the rows Up inserted unless something already ran against them (ingestion_job and
-- external_product cascade on delete, so a row with history is left in place, disabled).
BEGIN;

UPDATE data_source
SET enabled = false
WHERE name IN ('PicturePolishWooCommerce', 'IlnpWooCommerce', 'KbshimmerWooCommerce')
  AND metadata->>'insertedByMigration' = '20261108180000000';

DELETE FROM data_source AS ds
WHERE ds.name IN ('PicturePolishWooCommerce', 'IlnpWooCommerce', 'KbshimmerWooCommerce')
  AND ds.metadata->>'insertedByMigration' = '20261108180000000'
  AND NOT EXISTS (SELECT 1 FROM ingestion_job j WHERE j.data_source_id = ds.data_source_id)
  AND NOT EXISTS (SELECT 1 FROM external_product e WHERE e.data_source_id = ds.data_source_id);

COMMIT;
