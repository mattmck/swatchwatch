-- Up Migration

-- 20261017063252270_shade-review-queue.sql
-- Admin review queue for user-submitted shades (#45).
--
-- A shade created through the user polish API is `status = 'user_submitted'`: private to its
-- creator and to users holding it in inventory (migration 024). Admins now review those rows:
--
-- * approve → status = 'active' (optionally with corrected brand/name/finishes/hexes)
-- * reject  → status stays 'user_submitted' (still private to the submitter; no user data is
--             deleted), review_status = 'rejected'
-- * merge   → every user_inventory_item row moves to an existing active shade, aliases/SKUs/
--             catalog swatches are carried over, and the source row is retired in place:
--             status stays 'user_submitted' (so every existing visibility check keeps it private),
--             review_status = 'merged', merged_into_shade_id = the target. Retired rows are
--             hidden from user polish queries and redirect find-or-create lookups to the target.
--
-- Audit: there is no generic admin audit table, so the last decision is recorded on the shade
-- itself (who = reviewed_by_user_id, when = reviewed_at, what = review_status, why = review_note).
-- Every statement is idempotent so the file is safe to re-run.

BEGIN;

ALTER TABLE shade
  ADD COLUMN IF NOT EXISTS review_status TEXT NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS reviewed_by_user_id BIGINT NULL
    REFERENCES app_user(user_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS review_note TEXT NULL,
  ADD COLUMN IF NOT EXISTS merged_into_shade_id BIGINT NULL
    REFERENCES shade(shade_id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'shade_review_status_check' AND conrelid = 'shade'::regclass
  ) THEN
    ALTER TABLE shade
      ADD CONSTRAINT shade_review_status_check
      CHECK (review_status IS NULL OR review_status IN ('approved', 'rejected', 'merged'));
  END IF;

  -- merged_into_shade_id is only meaningful on a merged row (it may become NULL again if the
  -- target is ever hard-deleted, hence no reverse implication) and never points at itself.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'shade_merged_into_check' AND conrelid = 'shade'::regclass
  ) THEN
    ALTER TABLE shade
      ADD CONSTRAINT shade_merged_into_check
      CHECK (
        merged_into_shade_id IS NULL
        OR (review_status = 'merged' AND merged_into_shade_id <> shade_id)
      );
  END IF;
END $$;

-- Pending queue (GET /api/shades-admin/review): unreviewed submissions, oldest first.
CREATE INDEX IF NOT EXISTS idx_shade_review_pending
  ON shade (created_at, shade_id)
  WHERE status = 'user_submitted' AND review_status IS NULL;

-- FK lookups when a merge target is deleted, and "what was merged into X" queries.
CREATE INDEX IF NOT EXISTS idx_shade_merged_into
  ON shade (merged_into_shade_id)
  WHERE merged_into_shade_id IS NOT NULL;

COMMIT;

-- Down Migration

BEGIN;

DROP INDEX IF EXISTS idx_shade_merged_into;
DROP INDEX IF EXISTS idx_shade_review_pending;

ALTER TABLE shade
  DROP CONSTRAINT IF EXISTS shade_merged_into_check,
  DROP CONSTRAINT IF EXISTS shade_review_status_check;

ALTER TABLE shade
  DROP COLUMN IF EXISTS merged_into_shade_id,
  DROP COLUMN IF EXISTS review_note,
  DROP COLUMN IF EXISTS reviewed_by_user_id,
  DROP COLUMN IF EXISTS reviewed_at,
  DROP COLUMN IF EXISTS review_status;

COMMIT;
