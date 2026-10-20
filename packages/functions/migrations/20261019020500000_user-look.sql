-- Up Migration

-- 20261019020500000_user-look.sql
-- Saved looks (docs/looks-experience-plan.md §6 Phase 2; docs/schema.sql "Users + inventory").
--
-- A look saved from /polishes/looks: which template, the vibe it was generated for, and its
-- steps. The steps are an opaque display snapshot the client sends (role, label, hex, source and,
-- for steps with a polish, shade id + brand + name) and the API returns it to its owner as-is. It
-- is never joined to shade on read, so a saved look can't be used to read another user's private
-- user_submitted shade; it may go stale if a shade is renamed, which is fine for a bookmark.
-- look_key (`<templateId>:<shadeIds>`) makes saving the same combo twice an upsert. Every query is
-- scoped by user_id (issue #47); the API keeps at most 30 looks per user.

BEGIN;

CREATE TABLE IF NOT EXISTS user_look (
  user_look_id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES app_user(user_id) ON DELETE CASCADE,
  look_key TEXT NOT NULL,
  template_id TEXT NOT NULL,
  name TEXT NOT NULL,
  vibe JSONB NOT NULL,
  steps JSONB NOT NULL,
  saved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_user_look_key UNIQUE (user_id, look_key),
  CONSTRAINT chk_user_look_key CHECK (char_length(look_key) BETWEEN 3 AND 160),
  CONSTRAINT chk_user_look_template CHECK (template_id ~ '^[a-z0-9-]{1,40}$'),
  CONSTRAINT chk_user_look_name CHECK (char_length(name) BETWEEN 1 AND 80),
  CONSTRAINT chk_user_look_vibe CHECK (jsonb_typeof(vibe) = 'object'),
  CONSTRAINT chk_user_look_steps CHECK (
    jsonb_typeof(steps) = 'array'
    AND jsonb_array_length(steps) BETWEEN 1 AND 4
    AND octet_length(steps::text) <= 4000
  )
);

CREATE INDEX IF NOT EXISTS idx_user_look_user_saved
  ON user_look(user_id, saved_at DESC);

COMMIT;

-- Down Migration

BEGIN;

DROP TABLE IF EXISTS user_look;

COMMIT;
