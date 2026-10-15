-- Up Migration

-- 024_shade_user_submitted.sql
-- User-created shades stay private until an admin approves them (#47).
--
-- * shade.created_by_user_id — the app_user that created the row through the
--   user-facing polish API. NULL for catalog/ingestion shades (and every row that
--   exists today, which are left untouched).
-- * shade.status gains the value 'user_submitted' (status is free-form TEXT with no
--   CHECK constraint, so no constraint change is needed). A 'user_submitted' shade is
--   visible only to its creator and to users who hold it in their inventory;
--   promotion to the shared catalog = an admin sets status = 'active'.

BEGIN;

ALTER TABLE shade
  ADD COLUMN IF NOT EXISTS created_by_user_id BIGINT NULL
    REFERENCES app_user(user_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_shade_created_by_user
  ON shade (created_by_user_id)
  WHERE created_by_user_id IS NOT NULL;

COMMIT;

-- Down Migration

BEGIN;

DROP INDEX IF EXISTS idx_shade_created_by_user;

ALTER TABLE shade
  DROP COLUMN IF EXISTS created_by_user_id;

COMMIT;
