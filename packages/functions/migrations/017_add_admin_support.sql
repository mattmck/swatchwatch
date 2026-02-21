-- Up Migration

-- 017_add_admin_support.sql
-- Adds reference-data admin support:
-- - app_user.role safety checks
-- - finish_type audit columns
-- - harmony_type reference table + seed data

BEGIN;

-- Ensure app_user.role exists and is constrained.
ALTER TABLE app_user
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';

UPDATE app_user
SET role = 'user'
WHERE role IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'app_user_role_check'
      AND conrelid = 'app_user'::regclass
  ) THEN
    ALTER TABLE app_user
      ADD CONSTRAINT app_user_role_check
      CHECK (role IN ('user', 'admin'));
  END IF;
END $$;

-- Add audit columns to finish_type.
ALTER TABLE finish_type
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_by_user_id BIGINT;

UPDATE finish_type
SET
  created_at = COALESCE(created_at, now()),
  updated_at = COALESCE(updated_at, now())
WHERE created_at IS NULL
   OR updated_at IS NULL;

ALTER TABLE finish_type
  ALTER COLUMN created_at SET DEFAULT now(),
  ALTER COLUMN updated_at SET DEFAULT now(),
  ALTER COLUMN created_at SET NOT NULL,
  ALTER COLUMN updated_at SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'finish_type_updated_by_user_id_fkey'
      AND conrelid = 'finish_type'::regclass
  ) THEN
    ALTER TABLE finish_type
      ADD CONSTRAINT finish_type_updated_by_user_id_fkey
      FOREIGN KEY (updated_by_user_id)
      REFERENCES app_user(user_id)
      ON DELETE SET NULL;
  END IF;
END $$;

-- New admin-managed harmony reference table.
CREATE TABLE IF NOT EXISTS harmony_type (
  harmony_type_id SMALLSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  description TEXT,
  sort_order SMALLINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by_user_id BIGINT REFERENCES app_user(user_id) ON DELETE SET NULL
);

INSERT INTO harmony_type (name, display_name, description, sort_order) VALUES
  ('similar', 'Similar', 'Closest matches to the selected color family', 1),
  ('complementary', 'Complementary', 'Colors opposite on the color wheel', 2),
  ('split-complementary', 'Split Complementary', 'Base color plus the two neighbors of its complement', 3),
  ('analogous', 'Analogous', 'Adjacent colors on the color wheel', 4),
  ('triadic', 'Triadic', 'Three evenly spaced colors on the wheel', 5),
  ('tetradic', 'Tetradic', 'Two complementary pairs forming a rectangle', 6),
  ('monochromatic', 'Monochromatic', 'Single-hue variations in tint, tone, and shade', 7)
ON CONFLICT (name) DO NOTHING;

COMMIT;

-- Down Migration

BEGIN;

-- Keep role + finish_type audit columns intact because they may be required by
-- previously applied migrations/environments. Roll back only the new table.
DROP TABLE IF EXISTS harmony_type;

COMMIT;
