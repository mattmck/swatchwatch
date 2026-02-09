-- Up Migration

-- 006_add_user_external_id.sql
-- Adds external_id (B2C oid claim) and email to app_user for Azure AD B2C auth.
-- external_id is UNIQUE so we can upsert by it when validating JWTs.

ALTER TABLE app_user
  ADD COLUMN IF NOT EXISTS external_id TEXT UNIQUE;

ALTER TABLE app_user
  ADD COLUMN IF NOT EXISTS email TEXT;

COMMENT ON COLUMN app_user.external_id IS 'Azure AD B2C object ID (oid claim). Used to map JWT identity to local user.';
COMMENT ON COLUMN app_user.email IS 'User email from B2C claims, for display and lookup.';

-- Set external_id on seeded demo user so dev bypass can find them
UPDATE app_user SET external_id = 'dev-user-1' WHERE user_id = 1;


-- Down Migration

ALTER TABLE app_user DROP COLUMN IF EXISTS email;
ALTER TABLE app_user DROP COLUMN IF EXISTS external_id;
