-- Up Migration

-- 20261106130000000_retailer-source-kind-repair.sql
-- Repairs a PolishPickupShopify data_source row that was auto-provisioned (Admin Jobs opens
-- ensureSupportedShopifyDataSources) before it carried metadata.kind = 'retailer'; the
-- retailer-listings migration's INSERT ... ON CONFLICT DO NOTHING never fixes an existing row.

BEGIN;

UPDATE data_source
SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"kind":"retailer"}'::jsonb
WHERE name = 'PolishPickupShopify'
  AND (metadata ->> 'kind') IS DISTINCT FROM 'retailer';

COMMIT;

-- Down Migration

-- No-op: the code requires metadata.kind = 'retailer' for this source, so it is not reverted.
BEGIN;
COMMIT;
