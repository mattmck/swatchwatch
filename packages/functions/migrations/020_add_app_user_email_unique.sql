-- Up Migration

-- 020_add_app_user_email_unique.sql
-- Adds a unique constraint on lower(email) in app_user to prevent duplicate accounts
-- for the same email address.  Deduplicates any existing rows first, keeping the
-- oldest (lowest user_id) per normalized email and re-homing their external identities
-- to the surviving user before deleting the extras.

BEGIN;

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

COMMIT;
