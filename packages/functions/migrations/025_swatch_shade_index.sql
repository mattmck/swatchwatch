-- Up Migration

-- 025_swatch_shade_index.sql
-- The polish list/detail queries resolve each shade's latest swatch image with a
-- LATERAL subquery: `WHERE sw.shade_id = s.shade_id ORDER BY sw.swatch_id DESC LIMIT 1`.
-- swatch had no index on shade_id, so every shade row triggered a sequential scan of
-- swatch. This composite index serves both the lookup and the ORDER BY ... LIMIT 1.

CREATE INDEX IF NOT EXISTS idx_swatch_shade_latest
  ON swatch (shade_id, swatch_id DESC);

-- Down Migration

DROP INDEX IF EXISTS idx_swatch_shade_latest;
