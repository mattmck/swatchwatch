-- Up Migration

-- 20261017064751368_wishlist-share.sql
-- Shareable wishlist (issue #268, roadmap §3 Sprint 2 "Shareable wishlist").
--
-- One opt-in, revocable, read-only share link per user for their status = 'wishlist'
-- inventory (docs/schema.sql "Users + inventory"). The feature ships behind the
-- SHAREABLE_WISHLIST_ENABLED flag (off by default); this table is inert while it is off.
--
-- The raw token is never stored. It is derived on demand as
--   base64url(HMAC-SHA256(k, "<user_id>:<token_salt>")),  k = a purpose-bound subkey of
--   IMAGE_PROXY_SIGNING_KEY (src/lib/wishlist-share.ts),
-- and only its SHA-256 (token_hash, hex) is stored for lookup. A database leak alone (salt +
-- hash) therefore cannot be replayed into a working link: that needs the server key too.
-- Rotation replaces token_salt/token_hash; revocation deletes the row, so both take effect on
-- the next request. The owner's user_id is the key for every owner query (issue #47).

BEGIN;

CREATE TABLE IF NOT EXISTS wishlist_share (
  wishlist_share_id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES app_user(user_id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  token_salt TEXT NOT NULL,
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_wishlist_share_user UNIQUE (user_id),
  CONSTRAINT uq_wishlist_share_token_hash UNIQUE (token_hash),
  CONSTRAINT chk_wishlist_share_token_hash CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_wishlist_share_display_name CHECK (
    display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 60
  )
);

COMMIT;

-- Down Migration

BEGIN;

DROP TABLE IF EXISTS wishlist_share;

COMMIT;
