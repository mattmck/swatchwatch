-- Up Migration

-- 20261017232537776_inventory-event-keep-wear-history.sql
-- Keep wear history when a polish is deleted from the collection (decision D8, issue #317).
--
-- inventory_event used to hang off user_inventory_item with ON DELETE CASCADE, so deleting a
-- polish dropped its mani-log `used` events. Wear stats came back on re-add (they are derived
-- from manicure / manicure_polish, which are keyed by shade_id), but the events did not.
--
-- * inventory_event.user_id  — owner of the event (backfilled from the inventory row). NOT NULL;
--                              ON DELETE CASCADE with the account. Every query filters on it.
-- * inventory_event.shade_id — shade the event is about (backfilled from the inventory row),
--                              the same key the mani log uses; ON DELETE CASCADE like
--                              manicure_polish.shade_id.
-- * inventory_event.inventory_item_id — now nullable and ON DELETE SET NULL: deleting the
--                              inventory row detaches its events instead of deleting them. The
--                              API re-attaches detached events (user_id + shade_id) when the
--                              polish is re-added (recomputeWearStats in src/lib/manicure.ts).
--
-- See the inventory_event section of docs/schema.sql.

BEGIN;

ALTER TABLE inventory_event
  ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES app_user(user_id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS shade_id BIGINT REFERENCES shade(shade_id) ON DELETE CASCADE;

UPDATE inventory_event ie
SET user_id = ui.user_id,
    shade_id = ui.shade_id
FROM user_inventory_item ui
WHERE ui.inventory_item_id = ie.inventory_item_id
  AND ie.user_id IS NULL;

ALTER TABLE inventory_event
  ALTER COLUMN user_id SET NOT NULL,
  ALTER COLUMN inventory_item_id DROP NOT NULL;

ALTER TABLE inventory_event
  DROP CONSTRAINT IF EXISTS inventory_event_inventory_item_id_fkey;
ALTER TABLE inventory_event
  ADD CONSTRAINT inventory_event_inventory_item_id_fkey
  FOREIGN KEY (inventory_item_id) REFERENCES user_inventory_item(inventory_item_id) ON DELETE SET NULL;

-- Backs the FK's SET NULL on inventory deletes and the merge re-pointing.
CREATE INDEX IF NOT EXISTS idx_inventory_event_item
  ON inventory_event (inventory_item_id)
  WHERE inventory_item_id IS NOT NULL;

-- Re-attaching detached events on re-add.
CREATE INDEX IF NOT EXISTS idx_inventory_event_user_shade
  ON inventory_event (user_id, shade_id);

COMMENT ON COLUMN inventory_event.user_id IS 'Owner of the event; survives deleting the inventory row.';
COMMENT ON COLUMN inventory_event.shade_id IS 'Shade the event is about (mani-log key); survives deleting the inventory row.';
COMMENT ON COLUMN inventory_event.inventory_item_id IS 'Current inventory row for (user_id, shade_id); NULL while the polish is not in the collection.';

COMMIT;

-- Down Migration

-- Restores the cascading, NOT NULL inventory_item_id. Detached events are re-attached where the
-- user holds the shade again; the rest have no inventory row to hang off and are deleted.

BEGIN;

UPDATE inventory_event ie
SET inventory_item_id = ui.inventory_item_id
FROM user_inventory_item ui
WHERE ie.inventory_item_id IS NULL
  AND ui.user_id = ie.user_id
  AND ui.shade_id = ie.shade_id;

DELETE FROM inventory_event WHERE inventory_item_id IS NULL;

ALTER TABLE inventory_event
  DROP CONSTRAINT IF EXISTS inventory_event_inventory_item_id_fkey;
ALTER TABLE inventory_event
  ADD CONSTRAINT inventory_event_inventory_item_id_fkey
  FOREIGN KEY (inventory_item_id) REFERENCES user_inventory_item(inventory_item_id) ON DELETE CASCADE;

ALTER TABLE inventory_event
  ALTER COLUMN inventory_item_id SET NOT NULL;

COMMENT ON COLUMN inventory_event.inventory_item_id IS NULL;

DROP INDEX IF EXISTS idx_inventory_event_user_shade;
DROP INDEX IF EXISTS idx_inventory_event_item;

ALTER TABLE inventory_event
  DROP COLUMN IF EXISTS shade_id,
  DROP COLUMN IF EXISTS user_id;

COMMIT;
