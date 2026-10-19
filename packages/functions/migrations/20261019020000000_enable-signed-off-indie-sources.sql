-- Up Migration

-- 20261019020000000_enable-signed-off-indie-sources.sql
-- Enables Pahlish, Emily de Molly and Cirque Colors after the owner reported on 2026-10-19
-- that each store signed off on its products.json being read (#273, #328;
-- docs/indie-sources-2026-10.md). Who gave the OK and how is not recorded; the notes say so. The older
-- notes text is kept (history), with an update appended.
-- Only rows that are still pending are touched, so a row an admin already enabled (or an
-- operator's own wording in notes) is left alone. Keep in sync with docs/seed_data_sources.sql.

UPDATE data_source
SET enabled = true,
    metadata = (metadata - 'pendingApproval')
      || jsonb_build_object(
           'notes',
           coalesce(metadata->>'notes', '')
           || ' Update 2026-10-19: acceptable use confirmed: the owner reports the store signed off on 2026-10-19 (who and how not recorded here); the earlier "disabled pending approval" wording above no longer applies. Enabled 2026-10-19.'
         )
WHERE name IN ('PahlishShopify', 'EmilyDeMollyShopify', 'CirqueColorsShopify')
  AND metadata->>'pendingApproval' = 'true';


-- Down Migration
-- Disable the three sources again and restore the pending flag. The notes keep the sign-off
-- sentence (history is not rewritten); ingestion data already imported is untouched.
UPDATE data_source
SET enabled = false,
    metadata = metadata || '{"pendingApproval": true}'::jsonb
WHERE name IN ('PahlishShopify', 'EmilyDeMollyShopify', 'CirqueColorsShopify');
