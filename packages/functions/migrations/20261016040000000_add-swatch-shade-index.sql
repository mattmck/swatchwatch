-- Up Migration

-- 20261016040000000_add-swatch-shade-index.sql
-- The polish list/detail queries resolve each shade's primary swatch image with a
-- LATERAL subquery: `WHERE sw.shade_id = s.shade_id ORDER BY <source_product first>,
-- sw.swatch_id DESC LIMIT 1`. swatch had no index on shade_id, so every shade row
-- triggered a sequential scan of swatch. This index turns that into a range scan over
-- the handful of swatches a shade has; the remaining ORDER BY runs on that small set.

CREATE INDEX IF NOT EXISTS idx_swatch_shade_latest
  ON swatch (shade_id, swatch_id DESC);

-- Down Migration

DROP INDEX IF EXISTS idx_swatch_shade_latest;
