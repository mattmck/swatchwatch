-- Up Migration

-- 004_add_expiration_date.sql
-- Adds expiration_date to user_inventory_item so users can track polish shelf life.

ALTER TABLE user_inventory_item
  ADD COLUMN IF NOT EXISTS expiration_date DATE;

COMMENT ON COLUMN user_inventory_item.expiration_date IS 'User-tracked expiration date for the polish.';

-- Down Migration

ALTER TABLE user_inventory_item
  DROP COLUMN IF EXISTS expiration_date;
