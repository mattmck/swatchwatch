-- Migration 011: Split single color_hex into three provenance-tracked hex columns
--
-- Previously, vendor-supplied hex, AI-detected hex (from image), and color-name-derived
-- hex were merged into a single color_hex column, losing provenance information.
-- This migration separates them so each source is stored independently.

-- Add three new columns
ALTER TABLE user_inventory_item ADD COLUMN vendor_hex TEXT;
ALTER TABLE user_inventory_item ADD COLUMN detected_hex TEXT;
ALTER TABLE user_inventory_item ADD COLUMN name_hex TEXT;

COMMENT ON COLUMN user_inventory_item.vendor_hex IS 'Hex color from the vendor/retailer product data (e.g. Shopify variant options). Stored as-is even if suspicious/placeholder.';
COMMENT ON COLUMN user_inventory_item.detected_hex IS 'Hex color detected by AI from the product image (Azure OpenAI vision). Null if AI detection was not run or failed.';
COMMENT ON COLUMN user_inventory_item.name_hex IS 'Hex color inferred from the product color name via AI or builtin lookup. Null if no color name was available.';

-- Migrate existing data: copy color_hex to vendor_hex
-- Note: existing color_hex is a blend of vendor and AI-detected values due to the old
-- fallback logic (vendor || AI). Copying to vendor_hex is the safest default; records
-- will be re-classified correctly on the next ingestion run.
UPDATE user_inventory_item SET vendor_hex = color_hex WHERE color_hex IS NOT NULL;

-- Drop the old column
ALTER TABLE user_inventory_item DROP COLUMN color_hex;
