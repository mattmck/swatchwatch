-- Up Migration

-- 20261018175839000_finish-type-family.sql
-- Optional dupe-grading family on finish_type (issue #320, decision D10).
--
-- The dupe finder (packages/shared/src/color/dupes.ts) compares finish families:
-- finishes in the same family read alike on the nail, finishes in different
-- families drop a dupe's grade one step. Until now the families lived only in
-- the static DUPE_FINISH_FAMILIES map, so finish types created in the admin UI
-- had no family and always graded `unknown` against built-in finishes.
--
-- * family — one of FINISH_FAMILIES in packages/shared (solid, shimmer, holo,
--            glitter, matte, thermal, glow), or NULL for "no family" (such a
--            finish is never penalized). tests/finish-family.unit.test.cjs keeps
--            the CHECK list and the backfill below equal to the shared constants.
--
-- The backfill gives the seeded canonical finishes the families they map to in
-- DUPE_FINISH_FAMILIES today, so grading does not change. `other` stays NULL.
-- Rows an admin already set are left alone (family IS NULL guard).

BEGIN;

ALTER TABLE finish_type
  ADD COLUMN IF NOT EXISTS family TEXT;

ALTER TABLE finish_type
  DROP CONSTRAINT IF EXISTS finish_type_family_check;

ALTER TABLE finish_type
  ADD CONSTRAINT finish_type_family_check
  CHECK (family IS NULL OR family IN ('solid', 'shimmer', 'holo', 'glitter', 'matte', 'thermal', 'glow'));

UPDATE finish_type AS ft
SET family = seed.family
FROM (VALUES
  ('creme',       'solid'),
  ('crelly',      'solid'),
  ('jelly',       'solid'),
  ('sheer',       'solid'),
  ('shimmer',     'shimmer'),
  ('metallic',    'shimmer'),
  ('magnetic',    'shimmer'),
  ('duochrome',   'shimmer'),
  ('multichrome', 'shimmer'),
  ('holographic', 'holo'),
  ('glitter',     'glitter'),
  ('flake',       'glitter'),
  ('topper',      'glitter'),
  ('matte',       'matte'),
  ('thermal',     'thermal'),
  ('glow',        'glow')
) AS seed(name, family)
WHERE ft.name = seed.name
  AND ft.family IS NULL;

COMMIT;

-- Down Migration

BEGIN;

ALTER TABLE finish_type
  DROP CONSTRAINT IF EXISTS finish_type_family_check;

ALTER TABLE finish_type
  DROP COLUMN IF EXISTS family;

COMMIT;
