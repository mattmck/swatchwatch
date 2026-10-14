-- Up Migration

-- 023_add_shade_finishes.sql
-- Multi-finish shades (#43).
--
-- * shade.finishes text[]  — every canonical finish for the shade, primary first.
--   Values are limited to the build-time canonical list (CANONICAL_FINISHES in
--   packages/shared/src/constants/finishes.ts); the application enforces this.
-- * shade.finish stays as-is: it is still the shade identity/dedup key (see
--   idx_shade_unique) and the legacy single-finish field consumed by older clients.
-- * Backfill: finishes = ARRAY[canonical(finish)] where the legacy value is a
--   canonical name or a known finish_normalization alias. Unknown legacy values
--   (e.g. vendor-specific "iridescent") are left out; the next ingestion run fills
--   finishes from vendor tags.
-- * Adds a few alias rows seen in real Shopify tags (flakie/flakies/toppers).

BEGIN;

ALTER TABLE shade
  ADD COLUMN IF NOT EXISTS finishes text[] NOT NULL DEFAULT ARRAY[]::text[];

CREATE INDEX IF NOT EXISTS idx_shade_finishes ON shade USING GIN (finishes);

INSERT INTO finish_normalization (source_value, normalized_finish_name) VALUES
  ('flakie', 'flake'),
  ('flakies', 'flake'),
  ('toppers', 'topper')
ON CONFLICT (source_value) DO NOTHING;

WITH canonical(name) AS (
  VALUES
    ('creme'), ('sheer'), ('jelly'), ('shimmer'), ('metallic'), ('glitter'),
    ('holographic'), ('duochrome'), ('multichrome'), ('flake'), ('matte'),
    ('topper'), ('magnetic'), ('thermal'), ('crelly'), ('glow'), ('other')
),
legacy AS (
  SELECT
    shade_id,
    regexp_replace(lower(btrim(finish)), '\s+', ' ', 'g') AS finish_key
  FROM shade
  WHERE finish IS NOT NULL
    AND btrim(finish) <> ''
    AND cardinality(finishes) = 0
),
resolved AS (
  SELECT
    l.shade_id,
    COALESCE(
      (SELECT c.name FROM canonical c WHERE c.name = l.finish_key),
      (SELECT c.name
         FROM finish_normalization fn
         JOIN canonical c ON c.name = lower(btrim(fn.normalized_finish_name))
        WHERE lower(btrim(fn.source_value)) = l.finish_key
        LIMIT 1)
    ) AS finish_name
  FROM legacy l
)
UPDATE shade s
SET finishes = ARRAY[r.finish_name]
FROM resolved r
WHERE s.shade_id = r.shade_id
  AND r.finish_name IS NOT NULL;

COMMIT;

-- Down Migration

BEGIN;

DELETE FROM finish_normalization
WHERE (source_value, normalized_finish_name) IN (
  ('flakie', 'flake'),
  ('flakies', 'flake'),
  ('toppers', 'topper')
);

DROP INDEX IF EXISTS idx_shade_finishes;

ALTER TABLE shade
  DROP COLUMN IF EXISTS finishes;

COMMIT;
