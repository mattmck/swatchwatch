-- Up Migration

-- 20261110140000000_brand-store-vendor-aliases.sql
-- Vendor aliases for four brand stores whose first ingestion (2026-11-10, local database) stored
-- their products under a vendor spelling instead of the brand (resolveBrandStoreVendor reads
-- data_source.metadata.vendorAliases before the raw vendor):
-- * ChinaGlazeShopify: vendor "CG" (71 products) -> China Glaze;
-- * LeMiniMacaronShopify: "Le Mini Macaron Europe" (143) and "Camelia Beauty" (38, the
--   company's gel shades) -> Le Mini Macaron;
-- * StarrilyShopify: "Starrily Kelli Marissa" (20 collaboration shades) -> Starrily;
-- * LightsLacquerShopify: "lightslacquer.com" (1) -> Lights Lacquer.
-- Shade names are fixed in code (store title parsers and filters in
-- src/lib/connectors/store-filters/china-glaze.ts, le-mini-macaron.ts, starrily.ts and
-- cracked-polish.ts). Catalog shades already ingested are not touched here.
--
-- Only a row without vendorAliases is changed (an admin who already set some is left alone), so
-- every statement is idempotent. Each changed row is stamped metadata.vendorAliasesByMigration,
-- so Down removes exactly what Up added. Keep in sync with docs/seed_data_sources.sql.

BEGIN;

UPDATE data_source
SET metadata = COALESCE(metadata, '{}'::jsonb)
      || jsonb_build_object(
           'vendorAliases', '{"CG": "China Glaze"}'::jsonb,
           'vendorAliasesByMigration', '20261110140000000'
         )
WHERE name = 'ChinaGlazeShopify'
  AND NOT (COALESCE(metadata, '{}'::jsonb) ? 'vendorAliases');

UPDATE data_source
SET metadata = COALESCE(metadata, '{}'::jsonb)
      || jsonb_build_object(
           'vendorAliases', '{"Le Mini Macaron Europe": "Le Mini Macaron", "Camelia Beauty": "Le Mini Macaron"}'::jsonb,
           'vendorAliasesByMigration', '20261110140000000'
         )
WHERE name = 'LeMiniMacaronShopify'
  AND NOT (COALESCE(metadata, '{}'::jsonb) ? 'vendorAliases');

UPDATE data_source
SET metadata = COALESCE(metadata, '{}'::jsonb)
      || jsonb_build_object(
           'vendorAliases', '{"Starrily Kelli Marissa": "Starrily"}'::jsonb,
           'vendorAliasesByMigration', '20261110140000000'
         )
WHERE name = 'StarrilyShopify'
  AND NOT (COALESCE(metadata, '{}'::jsonb) ? 'vendorAliases');

UPDATE data_source
SET metadata = COALESCE(metadata, '{}'::jsonb)
      || jsonb_build_object(
           'vendorAliases', '{"lightslacquer.com": "Lights Lacquer"}'::jsonb,
           'vendorAliasesByMigration', '20261110140000000'
         )
WHERE name = 'LightsLacquerShopify'
  AND NOT (COALESCE(metadata, '{}'::jsonb) ? 'vendorAliases');

COMMIT;


-- Down Migration
-- Remove the aliases and the stamp, only on rows this migration's Up changed.
BEGIN;

UPDATE data_source
SET metadata = metadata - 'vendorAliases' - 'vendorAliasesByMigration'
WHERE name IN ('ChinaGlazeShopify', 'LeMiniMacaronShopify', 'StarrilyShopify', 'LightsLacquerShopify')
  AND metadata->>'vendorAliasesByMigration' = '20261110140000000';

COMMIT;
