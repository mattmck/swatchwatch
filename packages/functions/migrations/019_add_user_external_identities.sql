-- Up Migration

-- 019_add_user_external_identities.sql
-- Supports one local app_user per email with multiple linked external identities.

BEGIN;

CREATE TABLE IF NOT EXISTS user_external_identities (
  user_external_identity_id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES app_user(user_id) ON DELETE CASCADE,
  external_id TEXT NOT NULL UNIQUE,
  email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_external_identities_user_id
  ON user_external_identities(user_id);

-- Backfill existing app_user.external_id values so auth can transition without downtime.
INSERT INTO user_external_identities (user_id, external_id, email)
SELECT user_id, external_id, email
FROM app_user
WHERE external_id IS NOT NULL
ON CONFLICT (external_id) DO UPDATE
SET
  user_id = EXCLUDED.user_id,
  email = COALESCE(EXCLUDED.email, user_external_identities.email),
  last_seen_at = now();

COMMIT;

-- Down Migration

BEGIN;

DROP TABLE IF EXISTS user_external_identities;

COMMIT;
