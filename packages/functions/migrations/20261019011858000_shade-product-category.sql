-- Up Migration

-- 20261019011858000_shade-product-category.sql
-- Product category for shades and the non-polish cleanup (issues #349, #347; decision D23,
-- plan docs/plan-catalog-hygiene.md).
--
-- * shade.product_category — what kind of product the shade is: color (a color polish, the
--   default), topper, top_coat, base_coat, treatment or accessory. Every surface filters on it
--   (dupes, color search, gaps, photo match, Pick for me, stats). The classifier is
--   classifyProductCategory in packages/functions/src/lib/product-category.ts, whose rules mirror
--   docs/queries/catalog-hygiene-audit.sql; tests/product-category.unit.test.cjs keeps the CHECK
--   list equal to PRODUCT_CATEGORIES in packages/shared.
-- * shade.product_category_source — 'rule' (set by the classifier at ingestion or by the
--   backfill job) or 'admin' (set in the admin console). Ingestion and the backfill never change
--   an 'admin' category.
-- * shade.status gains the value 'excluded' (status is free-form TEXT, see migration 024): an
--   accessory nobody holds, hidden from every discovery surface. Holders keep seeing a shade
--   they hold, the same way user_submitted shades work. Nothing is hard-deleted.
-- * shade_category_change — one row per change the backfill job or an admin makes (category,
--   exclusion, cleared topper detected_hex), with the before/after values, so each one can be
--   undone. Like admin_audit_event, actor_user_id has no foreign key: the history outlives the
--   account.
--
-- New rows default to ('color', 'rule'), so nothing changes until the backfill runs.
-- See the "Catalog" section of docs/schema.sql.

BEGIN;

ALTER TABLE shade
  ADD COLUMN IF NOT EXISTS product_category TEXT NOT NULL DEFAULT 'color',
  ADD COLUMN IF NOT EXISTS product_category_source TEXT NOT NULL DEFAULT 'rule';

ALTER TABLE shade DROP CONSTRAINT IF EXISTS shade_product_category_check;
ALTER TABLE shade
  ADD CONSTRAINT shade_product_category_check
  CHECK (product_category IN ('color', 'topper', 'top_coat', 'base_coat', 'treatment', 'accessory'));

ALTER TABLE shade DROP CONSTRAINT IF EXISTS shade_product_category_source_check;
ALTER TABLE shade
  ADD CONSTRAINT shade_product_category_source_check
  CHECK (product_category_source IN ('rule', 'admin'));

CREATE INDEX IF NOT EXISTS idx_shade_product_category_status
  ON shade(product_category, status);

CREATE TABLE IF NOT EXISTS shade_category_change (
  shade_category_change_id BIGSERIAL PRIMARY KEY,
  shade_id BIGINT NOT NULL REFERENCES shade(shade_id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  -- Before/after values of the columns the action touched, e.g. {"productCategory": "color"}
  -- or the cleared detected hex with its provenance columns.
  before JSONB NOT NULL DEFAULT '{}'::jsonb,
  after JSONB NOT NULL DEFAULT '{}'::jsonb,
  source TEXT NOT NULL,
  actor_user_id BIGINT,
  -- Groups the rows one backfill run wrote (the runId in its report), so a run can be undone.
  backfill_run_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT shade_category_change_action_check
    CHECK (action IN ('category', 'exclude', 'clear_detected_hex')),
  CONSTRAINT shade_category_change_source_check
    CHECK (source IN ('backfill', 'admin'))
);

CREATE INDEX IF NOT EXISTS idx_shade_category_change_shade
  ON shade_category_change(shade_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_shade_category_change_run
  ON shade_category_change(backfill_run_id)
  WHERE backfill_run_id IS NOT NULL;

COMMIT;

-- Down Migration

BEGIN;

DROP TABLE IF EXISTS shade_category_change;

-- Excluded shades go back to the catalog: before this migration nothing was excluded.
UPDATE shade SET status = 'active' WHERE status = 'excluded';

DROP INDEX IF EXISTS idx_shade_product_category_status;

ALTER TABLE shade
  DROP CONSTRAINT IF EXISTS shade_product_category_source_check,
  DROP CONSTRAINT IF EXISTS shade_product_category_check,
  DROP COLUMN IF EXISTS product_category_source,
  DROP COLUMN IF EXISTS product_category;

COMMIT;
