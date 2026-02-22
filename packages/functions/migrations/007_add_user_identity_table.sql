-- Up Migration

-- 007_add_user_identity_table.sql
-- Adds user_identity table for provider-agnostic account linking so one app_user
-- can have multiple auth identities (auth0, stytch, google, github, etc.).

CREATE TABLE IF NOT EXISTS user_identity (
  user_identity_id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES app_user(user_id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  email_at_provider TEXT,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_user_id)
);

CREATE INDEX IF NOT EXISTS idx_user_identity_user_id ON user_identity (user_id);

-- Backfill existing single external_id mapping so old users continue to resolve.
INSERT INTO user_identity (user_id, provider, provider_user_id, email_at_provider, email_verified)
SELECT user_id, 'legacy', external_id, email, FALSE
FROM app_user
WHERE external_id IS NOT NULL
ON CONFLICT (provider, provider_user_id) DO NOTHING;


-- Down Migration

DROP INDEX IF EXISTS idx_user_identity_user_id;
DROP TABLE IF EXISTS user_identity;
