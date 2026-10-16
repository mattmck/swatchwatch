-- Up Migration

-- 20261016024959000_cleanup-gallery-swatches-on-primary-image.sql
-- Shopify re-ingestion looked up a shade's product swatch without filtering on
-- swatch_type, so it picked up the newest 'source_gallery' swatch, repointed it at the
-- primary image, and then re-inserted that gallery swatch. Every re-run left one more
-- gallery swatch pointing at the primary image.
--
-- 1. Delete gallery swatches that duplicate the shade's product swatch image.
-- 2. Collapse remaining duplicate gallery swatches (same shade + image) to the oldest row.
--    This covers shades whose product swatch still points at an older primary image; the
--    next ingestion run repoints the product swatch and drops the last duplicate.
--
-- Idempotent: re-running deletes nothing. color_features rows cascade with their swatch.

BEGIN;

DELETE FROM swatch g
USING swatch p
WHERE g.swatch_type = 'source_gallery'
  AND p.swatch_type = 'source_product'
  AND g.shade_id = p.shade_id
  AND g.image_id_original = p.image_id_original;

DELETE FROM swatch g
USING swatch keep
WHERE g.swatch_type = 'source_gallery'
  AND keep.swatch_type = 'source_gallery'
  AND g.shade_id = keep.shade_id
  AND g.image_id_original = keep.image_id_original
  AND keep.swatch_id < g.swatch_id;

COMMIT;

-- Down Migration

-- Data cleanup only: deleted duplicate swatches are not restored.
