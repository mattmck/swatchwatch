-- Up Migration

-- 20261111120000000_admin-sources-brands.sql
-- Admin Sources tab (docs/superpowers/specs/2026-11-10-admin-sources-brands-design.md).
--
-- * brand_ingest_profile: per-brand website, platform, blocker and notes, plus an optional explicit
--   link to the brand's own data_source (the admin "Brands" view).
-- * admin_audit_event gains the data source and brand actions the tab writes (target_user_id NULL,
--   ids in `changes`). The rewritten CHECK also includes 'shade.catalog_correct' from the brand-store
--   shade correction (PR #508, migration 20261110150000000), so the two migrations agree whichever
--   lands first.
-- * Seeds the three brands known to have no ingestible store (ILNP, KBShimmer, I Scream Nails) and
--   records the OKs already in the owner's notes for Mooncat and Cupcake Polish (2026-11-11) and
--   Emily de Molly and Cirque Colors (signed off 2026-10-19) as
--   `metadata.permission`, marked `recordedByMigration` so the Down removes only those.

BEGIN;

CREATE TABLE brand_ingest_profile (
  brand_id BIGINT PRIMARY KEY REFERENCES brand(brand_id) ON DELETE CASCADE,
  website_url TEXT,
  platform TEXT,
  blocker TEXT,
  notes TEXT,
  own_data_source_id BIGINT REFERENCES data_source(data_source_id) ON DELETE SET NULL,
  updated_by_user_id BIGINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT brand_ingest_profile_platform_check
    CHECK (platform IN ('shopify', 'woocommerce', 'bigcartel', 'custom', 'feed', 'none', 'unknown'))
);

ALTER TABLE admin_audit_event DROP CONSTRAINT IF EXISTS admin_audit_event_action_check;
ALTER TABLE admin_audit_event ADD CONSTRAINT admin_audit_event_action_check
  CHECK (action IN (
    'user.update', 'user.suspend', 'user.unsuspend', 'user.merge',
    'shade.vendor_hex_promote', 'shade.vendor_hex_demote',
    'shade.catalog_merge', 'shade.catalog_delete', 'shade.catalog_correct',
    'data_source.permission', 'data_source.enable', 'data_source.disable', 'data_source.images',
    'brand.create', 'brand.profile_update'
  ));

INSERT INTO brand (name_canonical)
SELECT v.name
FROM (VALUES ('ILNP'), ('KBShimmer'), ('I Scream Nails')) AS v(name)
WHERE NOT EXISTS (SELECT 1 FROM brand b WHERE lower(b.name_canonical) = lower(v.name))
  AND NOT EXISTS (SELECT 1 FROM brand_alias a WHERE lower(a.alias) = lower(v.name));

INSERT INTO brand_ingest_profile (brand_id, website_url, platform, blocker)
SELECT b.brand_id, p.website_url, p.platform, p.blocker
FROM (VALUES
  ('ILNP', 'https://www.ilnp.com', 'custom', 'Custom site (Laravel), no products feed'),
  ('KBShimmer', 'https://www.kbshimmer.com', 'woocommerce',
   'WooCommerce behind Cloudflare, which answers 403 to automated requests'),
  ('I Scream Nails', NULL, 'none', 'No official store; carried by Beyond Polish and Sleek Nail')
) AS p(name, website_url, platform, blocker)
-- Same lookup as the brand insert above: the canonical name first, else an alias, so a brand
-- known here under another canonical spelling still gets its profile.
CROSS JOIN LATERAL (
  SELECT COALESCE(
    (SELECT c.brand_id FROM brand c WHERE lower(c.name_canonical) = lower(p.name) ORDER BY c.brand_id LIMIT 1),
    (SELECT a.brand_id FROM brand_alias a WHERE lower(a.alias) = lower(p.name) ORDER BY a.brand_id LIMIT 1)
  ) AS brand_id
) b
WHERE b.brand_id IS NOT NULL
ON CONFLICT (brand_id) DO NOTHING;

UPDATE data_source
SET metadata = metadata || jsonb_build_object(
  'permission', jsonb_build_object(
    'status', 'granted',
    'summary', 'OK on record in the owner''s notes (recorded 2026-11-11)',
    'decidedAt', '2026-11-11',
    'imagesGranted', COALESCE((metadata ->> 'imagesPermitted')::boolean, true),
    'recordedByMigration', '20261111120000000'
  )
)
WHERE name IN ('MooncatShopify', 'CupcakePolishShopify')
  AND NOT (metadata ? 'permission');

UPDATE data_source
SET metadata = metadata || jsonb_build_object(
  'permission', jsonb_build_object(
    'status', 'granted',
    'summary', 'Acceptable use confirmed and signed off on 2026-10-19 (see notes)',
    'decidedAt', '2026-10-19',
    'imagesGranted', COALESCE((metadata ->> 'imagesPermitted')::boolean, true),
    'recordedByMigration', '20261111120000000'
  )
)
WHERE name IN ('EmilyDeMollyShopify', 'CirqueColorsShopify')
  AND NOT (metadata ? 'permission');

COMMIT;

-- Down Migration

BEGIN;

UPDATE data_source
SET metadata = metadata - 'permission'
WHERE metadata -> 'permission' ->> 'recordedByMigration' = '20261111120000000';

DELETE FROM admin_audit_event
WHERE action IN (
  'data_source.permission', 'data_source.enable', 'data_source.disable', 'data_source.images',
  'brand.create', 'brand.profile_update'
);

ALTER TABLE admin_audit_event DROP CONSTRAINT IF EXISTS admin_audit_event_action_check;
ALTER TABLE admin_audit_event ADD CONSTRAINT admin_audit_event_action_check
  CHECK (action IN (
    'user.update', 'user.suspend', 'user.unsuspend', 'user.merge',
    'shade.vendor_hex_promote', 'shade.vendor_hex_demote',
    'shade.catalog_merge', 'shade.catalog_delete', 'shade.catalog_correct'
  ));

-- The brand rows seeded above stay (they may have gained shades or aliases since).
DROP TABLE brand_ingest_profile;

COMMIT;
