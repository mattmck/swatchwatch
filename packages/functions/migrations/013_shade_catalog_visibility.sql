-- 013_shade_catalog_visibility.sql
-- Adds timestamps to shade records and enforces one inventory row per user+shade.
-- This supports treating shade as the global polish catalog entry while
-- keeping user_inventory_item strictly user-specific data.

-- Up Migration
ALTER TABLE shade
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_inventory_unique_shade
  ON user_inventory_item(user_id, shade_id)
  WHERE shade_id IS NOT NULL;

-- Down Migration
-- ALTER TABLE shade DROP COLUMN IF EXISTS created_at;
-- ALTER TABLE shade DROP COLUMN IF EXISTS updated_at;
-- DROP INDEX IF EXISTS idx_user_inventory_unique_shade;
