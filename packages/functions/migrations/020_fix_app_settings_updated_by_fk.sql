-- Up Migration

-- 020_fix_app_settings_updated_by_fk.sql
-- Compatibility migration: keep this filename in history for environments that
-- already recorded it as run. Re-applies the app_settings.updated_by FK with
-- ON DELETE SET NULL so the operation is idempotent.

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
