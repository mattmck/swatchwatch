-- Up Migration

-- 20261125120000000_unblock-ilnp-woocommerce.sql
-- Lifts the known-blocked state of IlnpWooCommerce (registered by 20261108180000000 with
-- metadata.blocked = "robots") after the owner reported on 2026-11-11 that ILNP is temporarily
-- allowing SwatchWatch to read its catalog.
-- - robots.txt still disallows /wp-json/ (checked 2026-11-25), so metadata.robotsOverride records the
--   OK the WooCommerce connector needs to read the Store API anyway. The Store API answered 200
--   with 745 products on 2026-11-25.
-- - base_url moves to https://www.ilnp.com, the host the store redirects to (the connector follows
--   same-origin redirects only).
-- - The source stays disabled and pending: this migration does not claim the OK. The owner records
--   it (who, date, channel, images, end date) in the admin Sources tab with "Record OK & turn on",
--   which grants the permission and enables the source.
-- Only a row still blocked for robots is touched, so an admin's own change is left alone. The older
-- notes text is kept (history) with an update appended. Keep in sync with docs/seed_data_sources.sql.

UPDATE data_source
SET base_url = 'https://www.ilnp.com',
    metadata = (metadata - 'blocked')
      || jsonb_build_object(
           'unblockedByMigration', '20261125120000000',
           'robotsOverride', 'The SwatchWatch owner reported on 2026-11-11 that ILNP is temporarily allowing SwatchWatch to read its catalog, including its WooCommerce Store API although robots.txt disallows /wp-json/. The permission record (admin Sources tab) holds who, channel and end date.',
           'verification', coalesce(metadata->'verification', '{}'::jsonb)
             || '{"checkedAt": "2026-11-25", "storeApi": true, "robotsTxt": "store-api-disallowed", "products": 745}'::jsonb,
           'notes',
           coalesce(metadata->>'notes', '')
           || ' Update 2026-11-25: the owner reports ILNP is temporarily allowing SwatchWatch to read its catalog (reported 2026-11-11). The known-blocked state was lifted and metadata.robotsOverride lets the connector read the Store API although robots.txt still disallows it; the KNOWN BLOCKED wording above no longer applies. The Store API answered 200 with 745 products. The source stays pending until the OK is recorded in the admin Sources tab (Record OK & turn on); disable it when the temporary access ends.'
         )
WHERE name = 'IlnpWooCommerce'
  AND metadata->>'blocked' = 'robots';


-- Down Migration
-- Restores the blocked state and the old base_url, only for the row this migration's Up changed
-- (metadata.unblockedByMigration). The notes and verification keep the 2026-11-25 update (history is
-- not rewritten); a permission recorded in the Sources tab and ingested data are untouched.
UPDATE data_source
SET base_url = 'https://ilnp.com',
    metadata = (metadata - 'unblockedByMigration' - 'robotsOverride')
      || '{"blocked": "robots"}'::jsonb
WHERE name = 'IlnpWooCommerce'
  AND metadata->>'unblockedByMigration' = '20261125120000000';
