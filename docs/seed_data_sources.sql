-- seed_data_sources_v1_1.sql
-- Idempotent seed data for easiest external/internal sources used by the MVP.
-- Target DB: PostgreSQL (uses ON CONFLICT DO UPDATE)

BEGIN;

INSERT INTO data_source (name, source_type, base_url, license, terms_url, enabled, metadata)
VALUES
  (
    'ManualEntry',
    'manual',
    NULL,
    NULL,
    NULL,
    true,
    '{"priority":"high","mvp":"yes","notes":"Admin/user manual edits and corrections. Always allowed; provenance used for audit."}'::jsonb
  ),
  (
    'UserCapture',
    'api',
    NULL,
    NULL,
    NULL,
    true,
    '{"priority":"highest","mvp":"yes","notes":"Your app-generated evidence: barcode frames, label photos, swatches. Private-by-default; opt-in sharing supported."}'::jsonb
  ),
  (
    'OpenBeautyFacts',
    'api',
    'https://world.openbeautyfacts.org',
    'Open Database License (ODbL) (verify obligations)',
    'https://world.openbeautyfacts.org/terms-of-use',
    true,
    '{"priority":"high","mvp":"yes","notes":"Barcode-first bootstrap for product name/brand and sometimes ingredients/labels. Coverage varies; cache by GTIN."}'::jsonb
  ),
  (
    'CosIng',
    'api',
    'https://ec.europa.eu/growth/sectors/cosmetics/cosing',
    'EU reference database (verify reuse terms)',
    'https://single-market-economy.ec.europa.eu/sectors/cosmetics/cosmetic-ingredient-database_en',
    true,
    '{"priority":"medium","mvp":"yes","notes":"Ingredient ontology/normalization (INCI names, functions). Not a product catalog."}'::jsonb
  ),
  (
    'ImpactAffiliateNetwork',
    'api',
    'https://impact.com',
    'Affiliate program terms per retailer/network',
    'https://impact.com/partner',
    true,
    '{"priority":"high","mvp":"yes","notes":"Retail deeplinks and (when available) product feeds. Use click-required outbound links + disclosure."}'::jsonb
  ),
  (
    'RakutenAdvertising',
    'api',
    'https://rakutenadvertising.com',
    'Affiliate program terms per retailer/network',
    'https://developers.rakutenadvertising.com',
    true,
    '{"priority":"high","mvp":"yes","notes":"Retail deeplinks and reporting via Rakuten Advertising. Avoid scraping; prefer official APIs/feeds."}'::jsonb
  ),
  (
    'GS1Lookup',
    'api',
    'https://www.gs1.org',
    'May be paid/limited (verify access level)',
    'https://www.gs1.org/services/verified-by-gs1',
    false,
    '{"priority":"low","mvp":"no","notes":"Optional GTIN validation / brand owner enrichment. Enable only if you have access and it is cost-effective."}'::jsonb
  ),
  (
    'openFDA_CosmeticEvents',
    'api',
    'https://open.fda.gov/apis/cosmetic/event/',
    'Public API (verify terms)',
    'https://open.fda.gov/apis/',
    false,
    '{"priority":"low","mvp":"no","notes":"Optional later: adverse event signals, not ingredients. Use careful UX and disclaimers."}'::jsonb
  )
ON CONFLICT (name) DO UPDATE
SET
  source_type = EXCLUDED.source_type,
  base_url    = EXCLUDED.base_url,
  license     = EXCLUDED.license,
  terms_url   = EXCLUDED.terms_url,
  enabled     = EXCLUDED.enabled,
  metadata    = EXCLUDED.metadata;

COMMIT;
