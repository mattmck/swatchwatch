-- Up Migration

-- 002_add_user_facing_columns.sql
-- Adds user-facing fields to user_inventory_item that the frontend Polish type expects
-- but aren't covered by the shade/sku canonical joins (color, hex, rating, tags, size, updated_at)

ALTER TABLE user_inventory_item
  ADD COLUMN IF NOT EXISTS color_name     TEXT,
  ADD COLUMN IF NOT EXISTS color_hex      TEXT,
  ADD COLUMN IF NOT EXISTS rating         SMALLINT CHECK (rating >= 1 AND rating <= 5),
  ADD COLUMN IF NOT EXISTS tags           TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS size_display   TEXT,
  ADD COLUMN IF NOT EXISTS updated_at     TIMESTAMPTZ NOT NULL DEFAULT now();

-- Backfill updated_at for any existing rows
UPDATE user_inventory_item SET updated_at = created_at WHERE updated_at = now() AND created_at <> now();

COMMENT ON COLUMN user_inventory_item.color_name   IS 'User-provided color name (e.g. "Red", "Teal"). May differ from canonical swatch color.';
COMMENT ON COLUMN user_inventory_item.color_hex    IS 'User-provided hex color (e.g. "#C4113C"). Used for color dots + color search.';
COMMENT ON COLUMN user_inventory_item.rating       IS 'User rating 1–5 stars. NULL = not rated.';
COMMENT ON COLUMN user_inventory_item.tags         IS 'User-assigned tags (e.g. {"favorite","indie","spring"}).';
COMMENT ON COLUMN user_inventory_item.size_display IS 'Display size string (e.g. "15ml", "0.5oz").';
COMMENT ON COLUMN user_inventory_item.updated_at   IS 'Last modification timestamp.';

-- Down Migration

ALTER TABLE user_inventory_item
  DROP COLUMN IF EXISTS color_name,
  DROP COLUMN IF EXISTS color_hex,
  DROP COLUMN IF EXISTS rating,
  DROP COLUMN IF EXISTS tags,
  DROP COLUMN IF EXISTS size_display,
  DROP COLUMN IF EXISTS updated_at;
