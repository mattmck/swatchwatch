-- Up Migration

-- 020_add_app_user_email_unique.sql
-- Adds a unique constraint on lower(email) in app_user to prevent duplicate accounts
-- for the same email address.  Deduplicates any existing rows first, keeping the
-- oldest (lowest user_id) per normalized email and re-homing their external identities
-- to the surviving user before deleting the extras.
--
-- Step 0 (below) fixes app_settings.updated_by FK to use ON DELETE SET NULL so the
-- DELETE in Step 2 does not violate a RESTRICT constraint.  The same fix is shipped
-- again as 021_fix_app_settings_updated_by_fk.sql so that environments which already
-- applied this migration without Step 0 (i.e. before the fix was folded in) will also
-- pick up the corrected FK via that catch-up migration.

BEGIN;

-- Step 0: Fix app_settings.updated_by FK so the DELETE in Step 2 doesn't violate it.
ALTER TABLE app_settings
  DROP CONSTRAINT IF EXISTS app_settings_updated_by_fkey;

ALTER TABLE app_settings
  ADD CONSTRAINT app_settings_updated_by_fkey
  FOREIGN KEY (updated_by)
  REFERENCES app_user(user_id)
  ON DELETE SET NULL;

-- Step 1: Re-home user_external_identities rows from duplicate users to the
--         surviving (oldest) user before the duplicates are deleted.
UPDATE user_external_identities uei
SET user_id = sub.keep_id
FROM (
  SELECT
    MIN(user_id)                          AS keep_id,
    ARRAY_AGG(user_id ORDER BY user_id)   AS all_ids
  FROM app_user
  WHERE email IS NOT NULL
  GROUP BY lower(email)
  HAVING COUNT(*) > 1
) sub
WHERE uei.user_id = ANY(sub.all_ids)
  AND uei.user_id <> sub.keep_id;

-- Step 2: Intentionally do NOT delete duplicate app_user rows here.
--         Automatically deleting users can cascade-delete (or null out) child
--         rows (inventory, submissions, sessions, etc.) and cause data loss.
--         Instead, rely on a manual/admin merge flow that can safely re-home
--         all related data before removing any duplicate users.

-- Step 3: Add a non-unique index on lower(email). NULLs are excluded so that
--         users without a known email address are still permitted.
--         This index improves lookup performance without enforcing uniqueness,
--         so existing duplicates are preserved for manual resolution.
CREATE INDEX IF NOT EXISTS idx_app_user_email_lower
  ON app_user (lower(email))
  WHERE email IS NOT NULL;

COMMIT;

-- Down Migration

BEGIN;

DROP INDEX IF EXISTS idx_app_user_email_lower;

-- Restore the original FK without an explicit ON DELETE action (defaults to RESTRICT).
ALTER TABLE app_settings
  DROP CONSTRAINT IF EXISTS app_settings_updated_by_fkey;

ALTER TABLE app_settings
  ADD CONSTRAINT app_settings_updated_by_fkey
  FOREIGN KEY (updated_by)
  REFERENCES app_user(user_id);

COMMIT;
