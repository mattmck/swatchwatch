-- Up Migration

-- 20261023001607416_look-share.sql
-- Shareable looks: one opt-in, revocable, read-only public link per saved look (user_look),
-- modeled on the shareable wishlist (20261017064751368_wishlist-share, issue #268). The feature
-- ships behind the SHAREABLE_LOOKS_ENABLED flag (off by default); this table is inert while it is
-- off. docs/schema.sql "Users + inventory" holds the canonical DDL.
--
-- The raw token is never stored. It is derived on demand as
--   base64url(HMAC-SHA256(k, "<user_id>:<user_look_id>:<token_salt>")),  k = the
--   "look-share:v1" subkey of IMAGE_PROXY_SIGNING_KEY (src/lib/look-share.ts; the wishlist uses a
--   different subkey, so the two token spaces never overlap),
-- and only its SHA-256 (token_hash, hex) is stored for lookup, so a database leak alone (salt +
-- hash) cannot be replayed into a working link.
--
-- Revoking sets revoked_at and keeps the hash, so the old link answers "turned off" (410) instead
-- of "not found"; sharing again writes a new salt/hash (new token) and clears revoked_at.
-- Deleting the saved look (by the owner, or the 30-look cap) cascades and kills the link.
-- The composite FK pins user_id to the look's owner, so a share row can never point at another
-- user's look; every owner query is keyed by user_id (issue #47).

BEGIN;

ALTER TABLE user_look
  ADD CONSTRAINT uq_user_look_id_user UNIQUE (user_look_id, user_id);

CREATE TABLE IF NOT EXISTS look_share (
  user_look_id BIGINT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES app_user(user_id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  token_salt TEXT NOT NULL,
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_look_share_look FOREIGN KEY (user_look_id, user_id)
    REFERENCES user_look(user_look_id, user_id) ON DELETE CASCADE,
  CONSTRAINT uq_look_share_token_hash UNIQUE (token_hash),
  CONSTRAINT chk_look_share_token_hash CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_look_share_token_salt CHECK (char_length(token_salt) BETWEEN 16 AND 64),
  CONSTRAINT chk_look_share_display_name CHECK (
    display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 60
  )
);

CREATE INDEX IF NOT EXISTS idx_look_share_user ON look_share(user_id);

COMMIT;

-- Down Migration

BEGIN;

DROP TABLE IF EXISTS look_share;

ALTER TABLE user_look DROP CONSTRAINT IF EXISTS uq_user_look_id_user;

COMMIT;
