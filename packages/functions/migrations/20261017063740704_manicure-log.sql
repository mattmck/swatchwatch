-- Up Migration

-- 20261017063740704_manicure-log.sql
-- Mani log / wear history (issue #269, roadmap §3 Sprint 3 "Mani log"; docs/schema.sql
-- "Users + inventory").
--
-- * manicure          — one logged manicure per row: the user, the date it was worn
--                       (`worn_on`, a calendar DATE in the user's own timezone), notes and an
--                       optional photo (`image_asset`, owner-checked by the API).
-- * manicure_polish   — the polishes in a manicure, each with a role
--                       (base | color | accent | topper | other) and a position (display order).
--                       Keyed by shade_id, not inventory_item_id: user_inventory_item is unique
--                       per (user_id, shade_id), so the shade identifies the caller's bottle, and
--                       removing then re-adding a polish does not orphan its history.
-- * inventory_event.manicure_id — links the `used` events the mani log writes to the manicure
--                       that caused them, so editing or deleting a manicure can resync them
--                       (ON DELETE CASCADE removes them with the manicure).
--
-- user_inventory_item.wear_count / last_worn_at (migration 20261017061336791_inventory-status)
-- are derived from these rows by the API (recomputed for the affected shades on every
-- create/edit/delete); tried_at is filled from the earliest wear when it is NULL and never
-- cleared by the mani log.

BEGIN;

CREATE TABLE IF NOT EXISTS manicure (
  manicure_id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES app_user(user_id) ON DELETE CASCADE,
  worn_on DATE NOT NULL,
  notes TEXT,
  photo_image_id BIGINT REFERENCES image_asset(image_id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_manicure_notes_length CHECK (notes IS NULL OR char_length(notes) <= 2000)
);

-- List (newest first, optional date range) is always scoped to one user.
CREATE INDEX IF NOT EXISTS idx_manicure_user_worn_on
  ON manicure (user_id, worn_on DESC, manicure_id DESC);

CREATE TABLE IF NOT EXISTS manicure_polish (
  manicure_polish_id BIGSERIAL PRIMARY KEY,
  manicure_id BIGINT NOT NULL REFERENCES manicure(manicure_id) ON DELETE CASCADE,
  shade_id BIGINT NOT NULL REFERENCES shade(shade_id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'color',
  position SMALLINT NOT NULL DEFAULT 0,
  CONSTRAINT chk_manicure_polish_role
    CHECK (role IN ('base', 'color', 'accent', 'topper', 'other')),
  CONSTRAINT chk_manicure_polish_position CHECK (position >= 0),
  CONSTRAINT uq_manicure_polish_shade_role UNIQUE (manicure_id, shade_id, role)
);

-- Wear-stat recomputation looks up every manicure that used a shade.
CREATE INDEX IF NOT EXISTS idx_manicure_polish_shade
  ON manicure_polish (shade_id, manicure_id);

ALTER TABLE inventory_event
  ADD COLUMN IF NOT EXISTS manicure_id BIGINT REFERENCES manicure(manicure_id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_inventory_event_manicure
  ON inventory_event (manicure_id)
  WHERE manicure_id IS NOT NULL;

COMMENT ON TABLE manicure IS 'Mani log: one logged manicure (user, worn_on date, notes, optional photo).';
COMMENT ON COLUMN manicure.worn_on IS 'Calendar date the manicure was worn (the user''s local date).';
COMMENT ON COLUMN manicure.photo_image_id IS 'Optional photo; must be an image_asset with owner_type = ''user'' and owner_id = user_id.';
COMMENT ON TABLE manicure_polish IS 'Polishes in a manicure with role (base|color|accent|topper|other) and display position.';
COMMENT ON COLUMN inventory_event.manicure_id IS 'Manicure that produced this event (event_type = ''used''); NULL for other events.';

COMMIT;

-- Down Migration

-- Drops the mani log. user_inventory_item.wear_count / last_worn_at / tried_at keep their last
-- computed values (those columns belong to 20261017061336791_inventory-status). The `used`
-- events the mani log wrote are deleted first: without manicure_id nothing could tell them
-- apart from other events any more.

BEGIN;

DELETE FROM inventory_event WHERE manicure_id IS NOT NULL;

DROP INDEX IF EXISTS idx_inventory_event_manicure;

ALTER TABLE inventory_event
  DROP COLUMN IF EXISTS manicure_id;

DROP TABLE IF EXISTS manicure_polish;
DROP TABLE IF EXISTS manicure;

COMMIT;
