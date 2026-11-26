-- Up Migration

-- 20261110150000000_brand-store-shade-correction.sql
-- Self-correcting brand-store re-runs (lib/brand-store-correction.ts): when a brand store's record
-- resolves through its own listing to a shade an earlier run filed under a vendor spelling ("CG",
-- "Le Mini Macaron Europe") or its raw title ("ALPENGLOW"), the materializer moves the shade to the
-- record's brand and clean name, or merges it into the brand's existing shade (mergeShadeInto,
-- already audited as 'shade.catalog_merge').
--
-- * admin_audit_event gains 'shade.catalog_correct': one row per moved or renamed shade (actor =
--   the admin who queued the ingestion job, target_user_id NULL, shade id, brand and name
--   before/after, data source and external id in `changes`). See docs/schema.sql.
-- The materializer writes the row inside a savepoint, so a database without this migration only
-- loses the audit row, never the ingestion record.

BEGIN;

ALTER TABLE admin_audit_event DROP CONSTRAINT IF EXISTS admin_audit_event_action_check;
ALTER TABLE admin_audit_event ADD CONSTRAINT admin_audit_event_action_check
  CHECK (action IN (
    'user.update', 'user.suspend', 'user.unsuspend', 'user.merge',
    'shade.vendor_hex_promote', 'shade.vendor_hex_demote',
    'shade.catalog_merge', 'shade.catalog_delete',
    'shade.catalog_correct'
  ));

COMMIT;

-- Down Migration

BEGIN;

DELETE FROM admin_audit_event
WHERE action = 'shade.catalog_correct';

ALTER TABLE admin_audit_event DROP CONSTRAINT IF EXISTS admin_audit_event_action_check;
ALTER TABLE admin_audit_event ADD CONSTRAINT admin_audit_event_action_check
  CHECK (action IN (
    'user.update', 'user.suspend', 'user.unsuspend', 'user.merge',
    'shade.vendor_hex_promote', 'shade.vendor_hex_demote',
    'shade.catalog_merge', 'shade.catalog_delete'
  ));

COMMIT;
