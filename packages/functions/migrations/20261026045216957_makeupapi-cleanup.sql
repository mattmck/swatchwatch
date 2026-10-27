-- Up Migration

-- 20261026045216957_makeupapi-cleanup.sql
-- MakeupAPI catalog cleanup (POST /api/shades-admin/makeupapi-dedupe/backfill, lib/makeupapi-dedupe.ts).
--
-- * Disable the MakeupAPI data source: its feed is frozen 2015 data whose product and image URLs
--   (well.ca, dior.com, d3t32hsnjxo7q6.cloudfront.net) are dead and whose hexes are scraped, and
--   brands it carries have their own store sources. Rows this migration disables are marked
--   (`metadata.disabledByMigration`) so the Down re-enables only those.
-- * admin_audit_event gains 'shade.catalog_merge' and 'shade.catalog_delete': the dedupe backfill
--   writes one per merged / deleted shade (target_user_id NULL, shade ids and the deleted row in
--   `changes`). See docs/schema.sql (admin_audit_event).

BEGIN;

UPDATE data_source
SET enabled = false,
    metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
      'disabledByMigration', '20261026045216957_makeupapi-cleanup',
      'notesBeforeDisable', metadata -> 'notes',
      'notes', 'Disabled 2026-10-26: frozen 2015 feed with dead product/image URLs and scraped hexes; duplicates cleaned up by the MakeupAPI dedupe backfill.'
    )
WHERE name = 'MakeupAPI'
  AND enabled = true;

ALTER TABLE admin_audit_event DROP CONSTRAINT IF EXISTS admin_audit_event_action_check;
ALTER TABLE admin_audit_event ADD CONSTRAINT admin_audit_event_action_check
  CHECK (action IN (
    'user.update', 'user.suspend', 'user.unsuspend', 'user.merge',
    'shade.vendor_hex_promote', 'shade.vendor_hex_demote',
    'shade.catalog_merge', 'shade.catalog_delete'
  ));

COMMIT;

-- Down Migration

BEGIN;

DELETE FROM admin_audit_event
WHERE action IN ('shade.catalog_merge', 'shade.catalog_delete');

ALTER TABLE admin_audit_event DROP CONSTRAINT IF EXISTS admin_audit_event_action_check;
ALTER TABLE admin_audit_event ADD CONSTRAINT admin_audit_event_action_check
  CHECK (action IN (
    'user.update', 'user.suspend', 'user.unsuspend', 'user.merge',
    'shade.vendor_hex_promote', 'shade.vendor_hex_demote'
  ));

UPDATE data_source
SET enabled = true,
    metadata = (metadata - 'disabledByMigration' - 'notesBeforeDisable' - 'notes')
      || CASE
           WHEN jsonb_typeof(metadata -> 'notesBeforeDisable') = 'string'
             THEN jsonb_build_object('notes', metadata -> 'notesBeforeDisable')
           ELSE '{}'::jsonb
         END
WHERE name = 'MakeupAPI'
  AND metadata ->> 'disabledByMigration' = '20261026045216957_makeupapi-cleanup';

COMMIT;
