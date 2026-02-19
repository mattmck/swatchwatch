-- Migration: Add unique constraint for user_inventory_item upsert operations
--
-- Problem: The ON CONFLICT upsert in polishes.ts uses (user_id, shade_id),
-- but only a partial unique index exists (WHERE shade_id IS NOT NULL).
-- ON CONFLICT requires a full constraint matching the conflict target.
--
-- Solution: Add a proper UNIQUE constraint on (user_id, shade_id).
-- The partial index is kept for performance on filtered queries.

ALTER TABLE user_inventory_item
ADD CONSTRAINT uq_user_inventory_shade UNIQUE (user_id, shade_id);
