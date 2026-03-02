-- Up Migration

-- 021_fix_app_settings_updated_by_fk.sql
-- Fixes app_settings.updated_by FK to use ON DELETE SET NULL.
-- Migration 010 created this column without an explicit ON DELETE action, which
-- defaults to RESTRICT and causes a FK violation when deleting an app_user row
-- (e.g. during a user-merge or deduplication operation).  Re-create the constraint
-- with ON DELETE SET NULL so that deleting a user automatically nulls the reference
-- instead of blocking the delete.
--
-- Kept as a separate migration from 020_add_app_user_email_unique.sql so that
-- environments which already applied 020 will also pick up this FK fix.

BEGIN;

ALTER TABLE app_settings
  DROP CONSTRAINT IF EXISTS app_settings_updated_by_fkey;

ALTER TABLE app_settings
  ADD CONSTRAINT app_settings_updated_by_fkey
  FOREIGN KEY (updated_by)
  REFERENCES app_user(user_id)
  ON DELETE SET NULL;

COMMIT;

-- Down Migration

BEGIN;

-- Restore the original FK without an explicit ON DELETE action (defaults to RESTRICT).
ALTER TABLE app_settings
  DROP CONSTRAINT IF EXISTS app_settings_updated_by_fkey;

ALTER TABLE app_settings
  ADD CONSTRAINT app_settings_updated_by_fkey
  FOREIGN KEY (updated_by)
  REFERENCES app_user(user_id);

COMMIT;
