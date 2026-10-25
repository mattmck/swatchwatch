-- Up Migration

-- 20261024053633287_shade-finishes-source.sql
-- Admin-set finishes from the Hex Labeling tool (and the polish detail sip panel).
--
-- * shade.finishes_source — 'rule' (ingestion / backfills, the default) or 'admin'. Ingestion
--   merges vendor tag finishes into shade.finishes and never removes one, so a finish an admin
--   took off would come back on the next ingest. An 'admin' list is never changed by ingestion
--   or the product-text backfill (same sticky rule as product_category_source = 'admin').
-- * shade_category_change gains the action 'finishes' so every admin finish edit is logged with
--   its before/after values next to the category changes of the same shade.
-- See the "Catalog" section of docs/schema.sql.

BEGIN;

ALTER TABLE shade
  ADD COLUMN IF NOT EXISTS finishes_source TEXT NOT NULL DEFAULT 'rule';

ALTER TABLE shade DROP CONSTRAINT IF EXISTS shade_finishes_source_check;
ALTER TABLE shade
  ADD CONSTRAINT shade_finishes_source_check
  CHECK (finishes_source IN ('rule', 'admin'));

ALTER TABLE shade_category_change DROP CONSTRAINT IF EXISTS shade_category_change_action_check;
ALTER TABLE shade_category_change
  ADD CONSTRAINT shade_category_change_action_check
  CHECK (action IN ('category', 'exclude', 'clear_detected_hex', 'finishes'));

COMMIT;

-- Down Migration

BEGIN;

DELETE FROM shade_category_change WHERE action = 'finishes';

ALTER TABLE shade_category_change DROP CONSTRAINT IF EXISTS shade_category_change_action_check;
ALTER TABLE shade_category_change
  ADD CONSTRAINT shade_category_change_action_check
  CHECK (action IN ('category', 'exclude', 'clear_detected_hex'));

ALTER TABLE shade
  DROP CONSTRAINT IF EXISTS shade_finishes_source_check,
  DROP COLUMN IF EXISTS finishes_source;

COMMIT;
