-- Fix app_settings.updated_by FK to use ON DELETE SET NULL
-- Migration 010 created this column without ON DELETE behaviour, which defaults to
-- RESTRICT and causes a FK violation when deleting an app_user row (e.g. during a
-- user-merge operation).  Re-create the constraint with ON DELETE SET NULL so that
-- deleting a user automatically nulls the reference instead of blocking the delete.

BEGIN;

ALTER TABLE app_settings
  DROP CONSTRAINT IF EXISTS app_settings_updated_by_fkey;

ALTER TABLE app_settings
  ADD CONSTRAINT app_settings_updated_by_fkey
  FOREIGN KEY (updated_by)
  REFERENCES app_user(user_id)
  ON DELETE SET NULL;

COMMIT;
