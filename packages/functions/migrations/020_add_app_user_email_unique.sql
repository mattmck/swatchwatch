-- Up Migration

-- 020_add_app_user_email_unique.sql
-- Adds a unique constraint on lower(email) in app_user to prevent duplicate accounts
-- for the same email address.  Deduplicates any existing rows first, keeping the
-- oldest (lowest user_id) per normalized email and re-homing their external identities
-- to the surviving user before deleting the extras.
--
-- Also fixes the app_settings.updated_by FK (created in migration 010 without an
-- ON DELETE action, defaulting to RESTRICT) to use ON DELETE SET NULL.  This must
-- run in the same transaction before the app_user DELETE below, otherwise the delete
-- would fail in environments that have not yet applied the FK fix.

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

-- Step 2: Delete duplicate app_user rows, keeping the oldest (lowest user_id)
--         per normalized email.  ON DELETE CASCADE on child tables removes any
--         remaining child rows automatically.
DELETE FROM app_user
WHERE user_id IN (
  SELECT user_id
  FROM (
    SELECT
      user_id,
      ROW_NUMBER() OVER (PARTITION BY lower(email) ORDER BY user_id) AS rn
    FROM app_user
    WHERE email IS NOT NULL
  ) ranked
  WHERE rn > 1
);

-- Step 3: Add the unique index.  NULLs are excluded so that users without a
--         known email address are still permitted.
CREATE UNIQUE INDEX IF NOT EXISTS idx_app_user_email_lower
  ON app_user (lower(email))
  WHERE email IS NOT NULL;

COMMIT;

-- Down Migration

BEGIN;

DROP INDEX IF EXISTS idx_app_user_email_lower;

COMMIT;
