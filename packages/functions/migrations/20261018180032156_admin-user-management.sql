-- Up Migration

-- 20261018180032156_admin-user-management.sql
-- Admin user management (issue #45): account suspension and an audit log of admin user actions.
--
-- * app_user.suspended_at / suspended_reason / suspended_by_user_id — a suspended account is one
--   with suspended_at set. The auth wrappers (withAuth / withAdmin in src/lib/auth.ts) answer 403
--   `account_suspended` for it without running the handler. Set and cleared only through
--   PATCH /api/users-admin/{id}; an admin cannot suspend their own account.
-- * admin_audit_event — who (actor) did what (action + before/after `changes`) to which user, and
--   when. actor_user_id / target_user_id are plain BIGINTs without foreign keys on purpose: the
--   history must outlive a merged or deleted account (a merge deletes the source user).
--
-- See the "Users + inventory" section of docs/schema.sql.

BEGIN;

ALTER TABLE app_user
  ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS suspended_reason TEXT,
  ADD COLUMN IF NOT EXISTS suspended_by_user_id BIGINT REFERENCES app_user(user_id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS admin_audit_event (
  admin_audit_event_id BIGSERIAL PRIMARY KEY,
  actor_user_id BIGINT NOT NULL,
  target_user_id BIGINT,
  action TEXT NOT NULL,
  changes JSONB NOT NULL DEFAULT '{}'::jsonb,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT admin_audit_event_action_check
    CHECK (action IN ('user.update', 'user.suspend', 'user.unsuspend', 'user.merge'))
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_event_target
  ON admin_audit_event(target_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_audit_event_actor
  ON admin_audit_event(actor_user_id, created_at DESC);

COMMIT;

-- Down Migration

BEGIN;

DROP TABLE IF EXISTS admin_audit_event;

ALTER TABLE app_user
  DROP COLUMN IF EXISTS suspended_by_user_id,
  DROP COLUMN IF EXISTS suspended_reason,
  DROP COLUMN IF EXISTS suspended_at;

COMMIT;
