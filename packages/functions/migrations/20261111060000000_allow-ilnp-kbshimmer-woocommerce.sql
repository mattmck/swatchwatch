-- Up Migration

-- 20261111060000000_allow-ilnp-kbshimmer-woocommerce.sql
-- Unblocks and enables IlnpWooCommerce and KbshimmerWooCommerce (registered known-blocked by
-- 20261108180000000) after the owner reported on 2026-11-11 that both stores are temporarily
-- allowing SwatchWatch to read their catalogs. Who gave the OK, how, and when the temporary
-- access ends are not recorded yet; the notes say so and the owner fills them in.
-- - ILNP: robots.txt still disallows /wp-json/, so metadata.robotsOverride records the OK the
--   WooCommerce connector needs to read the Store API anyway. The Store API answered 200 with
--   738 products on 2026-11-11.
-- - KBShimmer: every path, images included, still answers a Cloudflare challenge to plain
--   requests, so metadata.fetchVia = "brightdata-unlocker" sends the catalog and image requests
--   through the Bright Data Web Unlocker (lib/brightdata-unlocker.ts; BRIGHTDATA_API_KEY and
--   BRIGHTDATA_UNLOCKER_ZONE must be set, else the pull fails). Through it the Store API answered
--   200 with 371 products on 2026-11-11.
-- - metadata.permission records the OK as granted (images included) for the admin Sources tab
--   (migration 20261111120000000); grantedBy and channel are filled in there once known.
-- - base_url moves to the www host each store redirects to (the connector follows same-origin
--   redirects only).
-- Only rows still known-blocked are touched, so an admin's own change is left alone. The older
-- notes text is kept (history) with an update appended. Keep in sync with docs/seed_data_sources.sql.

UPDATE data_source
SET enabled = true,
    base_url = 'https://www.ilnp.com',
    metadata = (metadata - 'pendingApproval' - 'blocked')
      || jsonb_build_object(
           'enabledByMigration', '20261111060000000',
           'permission', jsonb_build_object(
             'status', 'granted',
             'summary', 'Temporary OK reported by the SwatchWatch owner on 2026-11-11: ILNP is temporarily allowing SwatchWatch to read its catalog (who, channel and end date not recorded yet)',
             'decidedAt', '2026-11-11',
             'imagesGranted', true
           ),
           'robotsOverride', 'Temporary OK reported by the SwatchWatch owner on 2026-11-11: ILNP is temporarily allowing SwatchWatch to read its WooCommerce Store API although robots.txt disallows /wp-json/ (who, channel and end date not recorded yet).',
           'verification', coalesce(metadata->'verification', '{}'::jsonb)
             || '{"checkedAt": "2026-11-11", "storeApi": true, "robotsTxt": "store-api-disallowed", "products": 738}'::jsonb,
           'notes',
           coalesce(metadata->>'notes', '')
           || ' Update 2026-11-11: acceptable use confirmed: the owner reports ILNP is temporarily allowing SwatchWatch to read its catalog (who, channel and end date not recorded here yet; record them as ''Acceptable use confirmed by <name, role> at ILNP on <date> via <channel>: <summary>''). robots.txt still disallows the Store API, so metadata.robotsOverride carries the OK; the KNOWN BLOCKED wording above no longer applies. The Store API answered 200 with 738 products. Enabled 2026-11-11; disable it when the temporary access ends.'
         )
WHERE name = 'IlnpWooCommerce'
  AND metadata->>'blocked' = 'robots';

UPDATE data_source
SET enabled = true,
    base_url = 'https://www.kbshimmer.com',
    metadata = (metadata - 'pendingApproval' - 'blocked')
      || jsonb_build_object(
           'enabledByMigration', '20261111060000000',
           'permission', jsonb_build_object(
             'status', 'granted',
             'summary', 'Temporary OK reported by the SwatchWatch owner on 2026-11-11: KBShimmer is temporarily allowing SwatchWatch to read its catalog (who, channel and end date not recorded yet)',
             'decidedAt', '2026-11-11',
             'imagesGranted', true
           ),
           'fetchVia', 'brightdata-unlocker',
           'verification', coalesce(metadata->'verification', '{}'::jsonb)
             || '{"checkedAt": "2026-11-11", "storeApi": true, "cloudflareChallenge": true, "fetchVia": "brightdata-unlocker", "products": 371}'::jsonb,
           'notes',
           coalesce(metadata->>'notes', '')
           || ' Update 2026-11-11: acceptable use confirmed: the owner reports KBShimmer is temporarily allowing SwatchWatch to read its catalog (who, channel and end date not recorded here yet; record them as ''Acceptable use confirmed by <name, role> at KBShimmer on <date> via <channel>: <summary>''). The Cloudflare challenge is still on every path, images included, so metadata.fetchVia sends requests through the Bright Data Web Unlocker until KBShimmer allowlists us; the KNOWN BLOCKED wording above no longer applies. Through the unlocker the Store API answered 200 with 371 products. Enabled 2026-11-11; disable it when the temporary access ends.'
         )
WHERE name = 'KbshimmerWooCommerce'
  AND metadata->>'blocked' = 'cloudflare';


-- Down Migration
-- Disable again and restore the blocked state, the pending flag and the old base_url, only for
-- rows this migration's Up changed (metadata.enabledByMigration). The notes and verification keep
-- the 2026-11-11 update (history is not rewritten); ingested data is untouched.
UPDATE data_source
SET enabled = false,
    base_url = 'https://ilnp.com',
    metadata = (metadata - 'enabledByMigration' - 'robotsOverride' - 'permission')
      || '{"pendingApproval": true, "blocked": "robots"}'::jsonb
WHERE name = 'IlnpWooCommerce'
  AND metadata->>'enabledByMigration' = '20261111060000000';

UPDATE data_source
SET enabled = false,
    base_url = 'https://kbshimmer.com',
    metadata = (metadata - 'enabledByMigration' - 'fetchVia' - 'permission')
      || '{"pendingApproval": true, "blocked": "cloudflare"}'::jsonb
WHERE name = 'KbshimmerWooCommerce'
  AND metadata->>'enabledByMigration' = '20261111060000000';
