-- Up Migration

-- 007_add_makeup_api_data_source.sql
-- Adds MakeupAPI as a first-class connector source for ingestion jobs.

INSERT INTO data_source (name, source_type, base_url, license, terms_url, enabled, metadata)
VALUES (
  'MakeupAPI',
  'api',
  'https://makeup-api.herokuapp.com',
  'Public API (verify terms)',
  'https://makeup-api.herokuapp.com',
  true,
  '{"priority":"medium","mvp":"yes","notes":"Nail polish catalog bootstrap with brand/name/hex color variants."}'::jsonb
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

DELETE FROM data_source WHERE name = 'MakeupAPI';
