-- Up Migration

-- 009_add_admin_role_and_ingestion_queue_support.sql
-- Adds app_user.role for admin authorization and seeds a local dev admin user.

BEGIN;

ALTER TABLE app_user
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'app_user_role_check'
      AND conrelid = 'app_user'::regclass
  ) THEN
    ALTER TABLE app_user
      ADD CONSTRAINT app_user_role_check
      CHECK (role IN ('user', 'admin'));
  END IF;
END $$;

UPDATE app_user
SET role = 'user'
WHERE role IS NULL;

-- Keep seeded dev user as non-admin.
UPDATE app_user
SET role = 'user'
WHERE user_id = 1;

-- Seed a local admin user for AUTH_DEV_BYPASS scenarios (Bearer dev:2).
INSERT INTO app_user (user_id, handle, external_id, email, role)
VALUES (2, 'admin-user', 'dev-admin-2', 'admin@swatchwatch.dev', 'admin')
ON CONFLICT (user_id) DO UPDATE
SET
  handle = EXCLUDED.handle,
  role = 'admin',
  external_id = COALESCE(app_user.external_id, EXCLUDED.external_id),
  email = COALESCE(app_user.email, EXCLUDED.email);

SELECT setval('app_user_user_id_seq', GREATEST(1, (SELECT MAX(user_id) FROM app_user)));

COMMIT;

-- Down Migration

BEGIN;

DELETE FROM app_user
WHERE user_id = 2
  AND external_id = 'dev-admin-2';

ALTER TABLE app_user
  DROP CONSTRAINT IF EXISTS app_user_role_check;

ALTER TABLE app_user
  DROP COLUMN IF EXISTS role;

COMMIT;
