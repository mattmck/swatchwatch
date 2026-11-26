-- Up Migration

-- 20261110130000000_retailer-images-permitted.sql
-- Stores product images for the two enabled retailers, Harlow & Co and Beyond Polish.
--
-- Decision D28 (docs/decisions-2026-10.md): D26 kept images off for every non-brand source until a
-- store's written OK that names images. On 2026-11-10 the owner decided to turn them on for these
-- two WITHOUT that OK, because a shade with no image can never get a measured colour (about 3,000
-- retailer-only shades: ILNP, KBShimmer, OPI, essie and others). Nobody at the stores confirmed
-- anything; the notes say so. Hypnotic Polish and Polish Pickup are not touched.
--
-- Only rows without an explicit imagesPermitted are touched, so the statements are idempotent and
-- an admin's own setting is left alone. Changed rows are stamped
-- metadata.imagesPermittedByMigration so Down reverts exactly those. Keep in sync with
-- docs/seed_data_sources.sql.

BEGIN;

UPDATE data_source
SET metadata = metadata
      || jsonb_build_object(
           'imagesPermitted', true,
           'imagesPermittedByMigration', '20261110130000000',
           'notes', COALESCE(metadata->>'notes', '') || ' Images: stored since 2026-11-10 by the owner''s decision (D28) without a written OK from the store that names images; ask the store for the record.'
         )
WHERE name IN ('HarlowAndCoShopify', 'BeyondPolishShopify')
  AND NOT (metadata ? 'imagesPermitted');

COMMIT;

-- Down Migration

BEGIN;

UPDATE data_source
SET metadata = (metadata - 'imagesPermitted' - 'imagesPermittedByMigration')
      || jsonb_build_object('notes', replace(COALESCE(metadata->>'notes', ''), ' Images: stored since 2026-11-10 by the owner''s decision (D28) without a written OK from the store that names images; ask the store for the record.', ''))
WHERE name IN ('HarlowAndCoShopify', 'BeyondPolishShopify')
  AND metadata->>'imagesPermittedByMigration' = '20261110130000000';

COMMIT;
