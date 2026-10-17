-- Up Migration

-- 20261017061336791_inventory-status.sql
-- Inventory status model (issue #261, roadmap §3 Sprint 1 "Inventory status").
--
-- Until now "wishlist" was the hack `quantity <= 0` on user_inventory_item. This adds a
-- real status plus wear tracking (docs/schema.sql "Users + inventory"):
--
-- * status       — owned | wishlist | destash | archived. "Untried" is NOT a status: it is
--                  derived as status = 'owned' AND tried_at IS NULL.
-- * tried_at     — when the user first tried (swatched / wore) the polish; NULL = untried.
-- * last_worn_at — last time the polish was worn (written by the mani log later).
-- * wear_count   — number of logged wears (default 0, never negative).
--
-- purchase_price / purchase_currency already exist (001_initial_schema) and are now
-- surfaced through the polishes API; no DDL change is needed for them.
--
-- Backfill mirrors the old hack exactly: quantity <= 0 → 'wishlist', otherwise 'owned'.
-- tried_at is left NULL for existing rows (we cannot know what was tried), so existing owned
-- rows start out as "untried".

BEGIN;

ALTER TABLE user_inventory_item
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'owned',
  ADD COLUMN IF NOT EXISTS tried_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_worn_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS wear_count INT NOT NULL DEFAULT 0;

UPDATE user_inventory_item
SET status = CASE WHEN quantity <= 0 THEN 'wishlist' ELSE 'owned' END;

ALTER TABLE user_inventory_item
  DROP CONSTRAINT IF EXISTS chk_user_inventory_item_status;
ALTER TABLE user_inventory_item
  ADD CONSTRAINT chk_user_inventory_item_status
    CHECK (status IN ('owned', 'wishlist', 'destash', 'archived'));

ALTER TABLE user_inventory_item
  DROP CONSTRAINT IF EXISTS chk_user_inventory_item_wear_count;
ALTER TABLE user_inventory_item
  ADD CONSTRAINT chk_user_inventory_item_wear_count
    CHECK (wear_count >= 0);

-- Status / untried filters on GET /api/polishes are always scoped to one user.
CREATE INDEX IF NOT EXISTS idx_user_inventory_status
  ON user_inventory_item (user_id, status);

COMMENT ON COLUMN user_inventory_item.status       IS 'Inventory status: owned | wishlist | destash | archived. "Untried" is derived (owned AND tried_at IS NULL).';
COMMENT ON COLUMN user_inventory_item.tried_at     IS 'When the user first tried the polish; NULL = untried.';
COMMENT ON COLUMN user_inventory_item.last_worn_at IS 'Last logged wear.';
COMMENT ON COLUMN user_inventory_item.wear_count   IS 'Number of logged wears.';

COMMIT;

-- Down Migration

-- Restores the pre-status encoding before dropping the columns, so the old
-- `quantity <= 0 means wishlist` code keeps its meaning: rows that are not owned
-- (wishlist / archived) get quantity 0, and owned/destash rows with no bottles get 1.
-- Lossy by design: status, tried_at, last_worn_at and wear_count are dropped.

BEGIN;

UPDATE user_inventory_item
SET quantity = 0
WHERE status IN ('wishlist', 'archived') AND quantity > 0;

UPDATE user_inventory_item
SET quantity = 1
WHERE status IN ('owned', 'destash') AND quantity <= 0;

DROP INDEX IF EXISTS idx_user_inventory_status;

ALTER TABLE user_inventory_item
  DROP CONSTRAINT IF EXISTS chk_user_inventory_item_wear_count,
  DROP CONSTRAINT IF EXISTS chk_user_inventory_item_status;

ALTER TABLE user_inventory_item
  DROP COLUMN IF EXISTS wear_count,
  DROP COLUMN IF EXISTS last_worn_at,
  DROP COLUMN IF EXISTS tried_at,
  DROP COLUMN IF EXISTS status;

COMMIT;
