-- Up Migration

-- 20261020032543929_guard-more-indie-shopify-sources-rollback.sql
-- Makes rolling back 20261019013349049_add-more-indie-shopify-sources safe. That migration
-- upserts the EmilyDeMollyShopify and CirqueColorsShopify data_source rows (a row may already
-- exist, auto-provisioned by createDataSourceIfMissing in src/lib/ingestion-repo.ts), but its
-- Down section deletes both rows whenever they have no ingestion_job or external_product,
-- so a rollback could delete a row that existed before it and lose its metadata.ingestion
-- settings (CodeRabbit on #375). Committed migrations are never edited, so the fix lives here:
--
-- * Up marks the rows 20261019013349049 itself inserted with
--   metadata.insertedByMigration = '20261019013349049'. That migration recorded nothing, so
--   they are recognised after the fact: node-pg-migrate's pgmigrations.run_on is NOW() taken
--   right after the INSERT (the same value in one transaction, a few ms later otherwise) and
--   data_source.created_at defaults to now(), so an inserted row has created_at at most a few
--   seconds before run_on. A row created earlier, or carrying metadata.autoProvisioned (the
--   upsert merges metadata, so that key survives), existed before and is never marked.
--   Anything ambiguous stays unmarked, which only means a rollback keeps it, disabled.
-- * The Down section installs a BEFORE DELETE guard on data_source that skips (with a
--   NOTICE) the delete of either row unless it carries the marker. A rollback runs this
--   migration's Down before 20261019013349049's Down, so that DELETE then removes only the
--   rows the migration inserted; a pre-existing row stays in place, disabled by its UPDATE.
--   The marker is kept for the guard. Running Up again drops the guard; after rolling back
--   past 20261019013349049 it can be dropped by hand (DROP TRIGGER
--   data_source_keep_preexisting_indie_shopify_rows ON data_source; DROP FUNCTION
--   data_source_keep_preexisting_indie_shopify_rows();), which is also how to delete such a
--   row on purpose while the guard is installed.

BEGIN;

UPDATE data_source AS ds
SET metadata = COALESCE(ds.metadata, '{}'::jsonb)
      || '{"insertedByMigration": "20261019013349049"}'::jsonb
FROM pgmigrations AS m
WHERE m.name = '20261019013349049_add-more-indie-shopify-sources'
  AND ds.name IN ('EmilyDeMollyShopify', 'CirqueColorsShopify')
  AND NOT COALESCE(ds.metadata ? 'autoProvisioned', false)
  AND ds.created_at <= m.run_on
  AND ds.created_at > m.run_on - interval '10 seconds';

DROP TRIGGER IF EXISTS data_source_keep_preexisting_indie_shopify_rows ON data_source;
DROP FUNCTION IF EXISTS data_source_keep_preexisting_indie_shopify_rows();

COMMIT;


-- Down Migration
-- Install the guard (see the header) and keep the marker it reads, so the next migration
-- rolled back, 20261019013349049, deletes only the rows it inserted.
BEGIN;

CREATE OR REPLACE FUNCTION data_source_keep_preexisting_indie_shopify_rows()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE NOTICE 'data_source % not deleted: it existed before migration 20261019013349049', OLD.name;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS data_source_keep_preexisting_indie_shopify_rows ON data_source;
CREATE TRIGGER data_source_keep_preexisting_indie_shopify_rows
  BEFORE DELETE ON data_source
  FOR EACH ROW
  WHEN (
    OLD.name IN ('EmilyDeMollyShopify', 'CirqueColorsShopify')
    AND (OLD.metadata->>'insertedByMigration') IS DISTINCT FROM '20261019013349049'
  )
  EXECUTE FUNCTION data_source_keep_preexisting_indie_shopify_rows();

COMMIT;
