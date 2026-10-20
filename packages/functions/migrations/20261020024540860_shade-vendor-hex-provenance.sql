-- Up Migration

-- 20261020024540860_shade-vendor-hex-provenance.sql
-- Provenance for shade.vendor_hex so an admin can promote a hand-picked ground-truth label
-- (color_training_sample, source_type = 'manual') to the shade's vendor hex (#321, decision D12)
-- and the promoted value can be told apart from vendor data and undone.
--
-- * vendor_hex_source         — 'vendor' (vendor/catalog data; every pre-existing vendor hex) or
--                               'manual_label' (promoted by an admin); NULL = unknown / no hex.
--                               Ingestion never overwrites vendor_hex while it is 'manual_label'
--                               (it records the vendor's latest value in vendor_hex_previous).
-- * vendor_hex_label_id       — the promoted label. ON DELETE SET NULL: deleting the label keeps
--                               the promoted hex (and 'manual_label'), it only loses the link.
-- * vendor_hex_set_by_user_id — admin who promoted it (NULL for vendor data).
-- * vendor_hex_set_at         — when vendor_hex was last written by a promotion or ingestion.
-- * vendor_hex_previous       — the vendor hex a promotion replaced; Undo restores it.
--
-- hex_agreement and color_family are generated from vendor_hex, so they follow a promotion
-- automatically. admin_audit_event gains the two shade actions (target_user_id stays NULL; the
-- shade id is in `changes`). See docs/schema.sql (shade, admin_audit_event).

BEGIN;

ALTER TABLE shade
  ADD COLUMN IF NOT EXISTS vendor_hex_source TEXT,
  ADD COLUMN IF NOT EXISTS vendor_hex_label_id BIGINT,
  ADD COLUMN IF NOT EXISTS vendor_hex_set_by_user_id BIGINT,
  ADD COLUMN IF NOT EXISTS vendor_hex_set_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS vendor_hex_previous TEXT;

ALTER TABLE shade DROP CONSTRAINT IF EXISTS shade_vendor_hex_source_check;
ALTER TABLE shade ADD CONSTRAINT shade_vendor_hex_source_check
  CHECK (vendor_hex_source IS NULL OR vendor_hex_source IN ('vendor', 'manual_label'));

ALTER TABLE shade DROP CONSTRAINT IF EXISTS shade_vendor_hex_label_id_fkey;
ALTER TABLE shade ADD CONSTRAINT shade_vendor_hex_label_id_fkey
  FOREIGN KEY (vendor_hex_label_id) REFERENCES color_training_sample(training_sample_id) ON DELETE SET NULL;

ALTER TABLE shade DROP CONSTRAINT IF EXISTS shade_vendor_hex_set_by_user_id_fkey;
ALTER TABLE shade ADD CONSTRAINT shade_vendor_hex_set_by_user_id_fkey
  FOREIGN KEY (vendor_hex_set_by_user_id) REFERENCES app_user(user_id) ON DELETE SET NULL;

-- Every vendor hex stored before D12 came from vendor/catalog data.
UPDATE shade
SET vendor_hex_source = 'vendor'
WHERE vendor_hex IS NOT NULL
  AND vendor_hex_source IS NULL;

CREATE INDEX IF NOT EXISTS idx_shade_vendor_hex_label
  ON shade (vendor_hex_label_id)
  WHERE vendor_hex_label_id IS NOT NULL;

ALTER TABLE admin_audit_event DROP CONSTRAINT IF EXISTS admin_audit_event_action_check;
ALTER TABLE admin_audit_event ADD CONSTRAINT admin_audit_event_action_check
  CHECK (action IN (
    'user.update', 'user.suspend', 'user.unsuspend', 'user.merge',
    'shade.vendor_hex_promote', 'shade.vendor_hex_demote'
  ));

COMMIT;

-- Down Migration

BEGIN;

-- Undo outstanding promotions so the vendor data comes back.
UPDATE shade
SET vendor_hex = vendor_hex_previous
WHERE vendor_hex_source = 'manual_label';

DELETE FROM admin_audit_event
WHERE action IN ('shade.vendor_hex_promote', 'shade.vendor_hex_demote');

ALTER TABLE admin_audit_event DROP CONSTRAINT IF EXISTS admin_audit_event_action_check;
ALTER TABLE admin_audit_event ADD CONSTRAINT admin_audit_event_action_check
  CHECK (action IN ('user.update', 'user.suspend', 'user.unsuspend', 'user.merge'));

DROP INDEX IF EXISTS idx_shade_vendor_hex_label;

ALTER TABLE shade
  DROP CONSTRAINT IF EXISTS shade_vendor_hex_set_by_user_id_fkey,
  DROP CONSTRAINT IF EXISTS shade_vendor_hex_label_id_fkey,
  DROP CONSTRAINT IF EXISTS shade_vendor_hex_source_check,
  DROP COLUMN IF EXISTS vendor_hex_previous,
  DROP COLUMN IF EXISTS vendor_hex_set_at,
  DROP COLUMN IF EXISTS vendor_hex_set_by_user_id,
  DROP COLUMN IF EXISTS vendor_hex_label_id,
  DROP COLUMN IF EXISTS vendor_hex_source;

COMMIT;
