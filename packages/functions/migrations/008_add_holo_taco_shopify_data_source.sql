-- Up Migration

-- 008_add_holo_taco_shopify_data_source.sql
-- Adds HoloTacoShopify as a first-class connector source for ingestion jobs.

INSERT INTO data_source (name, source_type, base_url, license, terms_url, enabled, metadata)
VALUES (
  'HoloTacoShopify',
  'api',
  'https://www.holotaco.com',
  'Storefront terms apply (verify metadata/image usage obligations)',
  'https://www.holotaco.com/pages/terms-of-service',
  true,
  '{"priority":"high","mvp":"yes","notes":"Current Holo Taco Shopify storefront pull for recent searchable shades, variant SKU/barcode, and images."}'::jsonb
)
ON CONFLICT (name) DO UPDATE
SET
  source_type = EXCLUDED.source_type,
  base_url = EXCLUDED.base_url,
  license = EXCLUDED.license,
  terms_url = EXCLUDED.terms_url,
  enabled = EXCLUDED.enabled,
  metadata = EXCLUDED.metadata;


-- Down Migration

DELETE FROM data_source WHERE name = 'HoloTacoShopify';
