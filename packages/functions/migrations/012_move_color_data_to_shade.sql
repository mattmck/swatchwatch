-- Migration 012: Move product-level color data from user_inventory_item to shade
--
-- color_name, vendor_hex, detected_hex, name_hex describe the PRODUCT, not the
-- user's relationship with it.  They belong on the canonical shade table.

-- UP: Add color columns to shade
ALTER TABLE shade ADD COLUMN IF NOT EXISTS color_name TEXT;
ALTER TABLE shade ADD COLUMN IF NOT EXISTS vendor_hex TEXT;
ALTER TABLE shade ADD COLUMN IF NOT EXISTS detected_hex TEXT;
ALTER TABLE shade ADD COLUMN IF NOT EXISTS name_hex TEXT;

-- Populate shade from inventory (prefer rows with most color data, most recent)
UPDATE shade s
SET
  color_name   = COALESCE(s.color_name,   src.color_name),
  vendor_hex   = COALESCE(s.vendor_hex,   src.vendor_hex),
  detected_hex = COALESCE(s.detected_hex, src.detected_hex),
  name_hex     = COALESCE(s.name_hex,     src.name_hex)
FROM (
  SELECT DISTINCT ON (shade_id)
    shade_id, color_name, vendor_hex, detected_hex, name_hex
  FROM user_inventory_item
  WHERE shade_id IS NOT NULL
  ORDER BY shade_id,
    (CASE WHEN vendor_hex IS NOT NULL THEN 1 ELSE 0 END
     + CASE WHEN detected_hex IS NOT NULL THEN 1 ELSE 0 END
     + CASE WHEN name_hex IS NOT NULL THEN 1 ELSE 0 END
     + CASE WHEN color_name IS NOT NULL THEN 1 ELSE 0 END) DESC,
    updated_at DESC NULLS LAST
) src
WHERE s.shade_id = src.shade_id;

-- Drop deprecated columns from user_inventory_item
ALTER TABLE user_inventory_item DROP COLUMN IF EXISTS color_name;
ALTER TABLE user_inventory_item DROP COLUMN IF EXISTS vendor_hex;
ALTER TABLE user_inventory_item DROP COLUMN IF EXISTS detected_hex;
ALTER TABLE user_inventory_item DROP COLUMN IF EXISTS name_hex;

-- DOWN:
-- ALTER TABLE user_inventory_item ADD COLUMN color_name TEXT;
-- ALTER TABLE user_inventory_item ADD COLUMN vendor_hex TEXT;
-- ALTER TABLE user_inventory_item ADD COLUMN detected_hex TEXT;
-- ALTER TABLE user_inventory_item ADD COLUMN name_hex TEXT;
-- UPDATE user_inventory_item ui SET color_name = s.color_name, vendor_hex = s.vendor_hex, detected_hex = s.detected_hex, name_hex = s.name_hex FROM shade s WHERE ui.shade_id = s.shade_id;
-- ALTER TABLE shade DROP COLUMN color_name, DROP COLUMN vendor_hex, DROP COLUMN detected_hex, DROP COLUMN name_hex;
