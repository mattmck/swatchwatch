-- Up Migration

-- 20261020033727156_guard-indie-shopify-sources-rollback.sql
-- Makes rolling back 20261017062550000_add-indie-shopify-sources safe. That migration
-- upserts the NightOwlLacquerShopify and PahlishShopify data_source rows (a row may already
-- exist, auto-provisioned by createDataSourceIfMissing in src/lib/ingestion-repo.ts), but its
-- Down section deletes both rows whenever they have no ingestion_job or external_product,
-- so a rollback could delete a row that existed before it and lose its metadata.ingestion
-- settings. Same flaw and same fix as 20261020032543929_guard-more-indie-shopify-sources-rollback
-- (#394) for the later migration. Committed migrations are never edited, so the fix lives here:
--
-- * Up marks the rows 20261017062550000 itself inserted with
--   metadata.insertedByMigration = '20261017062550000'. That migration recorded nothing, so
--   they are recognised after the fact: node-pg-migrate's pgmigrations.run_on is NOW() taken
--   right after the INSERT (the same value in one transaction, a few ms later otherwise) and
--   data_source.created_at defaults to now(), so an inserted row has created_at at most a few
--   seconds before run_on. A row created earlier, or carrying metadata.autoProvisioned (the
--   upsert merges metadata, so that key survives), existed before and is never marked.
--   Anything ambiguous stays unmarked, which only means a rollback keeps it, disabled.
--   Later migrations merge into metadata (||), so the marker survives them.
-- * The Down section installs a BEFORE DELETE guard on data_source that skips (with a
--   NOTICE) the delete of either row unless it carries the marker. A rollback runs this
--   migration's Down before 20261017062550000's Down, so that DELETE then removes only the
--   rows the migration inserted; a pre-existing row stays in place, disabled by its UPDATE.
--   The marker is kept for the guard. Running Up again drops the guard; after rolling back
--   past 20261017062550000 it can be dropped by hand (DROP TRIGGER
--   data_source_keep_preexisting_nightowl_pahlish_rows ON data_source; DROP FUNCTION
--   data_source_keep_preexisting_nightowl_pahlish_rows();), which is also how to delete such
--   a row on purpose while the guard is installed. Its name differs from the #394 guard's so
--   both can be installed at once.

BEGIN;

UPDATE data_source AS ds
SET metadata = COALESCE(ds.metadata, '{}'::jsonb)
      || '{"insertedByMigration": "20261017062550000"}'::jsonb
FROM pgmigrations AS m
WHERE m.name = '20261017062550000_add-indie-shopify-sources'
  AND ds.name IN ('NightOwlLacquerShopify', 'PahlishShopify')
  AND NOT COALESCE(ds.metadata ? 'autoProvisioned', false)
  AND ds.created_at <= m.run_on
  AND ds.created_at > m.run_on - interval '10 seconds';

DROP TRIGGER IF EXISTS data_source_keep_preexisting_nightowl_pahlish_rows ON data_source;
DROP FUNCTION IF EXISTS data_source_keep_preexisting_nightowl_pahlish_rows();

COMMIT;


-- Down Migration
-- Install the guard (see the header) and keep the marker it reads, so the rollback of
-- 20261017062550000 deletes only the rows it inserted.
BEGIN;

CREATE OR REPLACE FUNCTION data_source_keep_preexisting_nightowl_pahlish_rows()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE NOTICE 'data_source % not deleted: it existed before migration 20261017062550000', OLD.name;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS data_source_keep_preexisting_nightowl_pahlish_rows ON data_source;
CREATE TRIGGER data_source_keep_preexisting_nightowl_pahlish_rows
  BEFORE DELETE ON data_source
  FOR EACH ROW
  WHEN (
    OLD.name IN ('NightOwlLacquerShopify', 'PahlishShopify')
    AND (OLD.metadata->>'insertedByMigration') IS DISTINCT FROM '20261017062550000'
  )
  EXECUTE FUNCTION data_source_keep_preexisting_nightowl_pahlish_rows();

COMMIT;
