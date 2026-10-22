-- Up Migration

-- 20261019013349049_add-more-indie-shopify-sources.sql
-- Registers two more indie Shopify stores for the generic Shopify connector (#273), DISABLED.
-- Both were surveyed on 2026-10-18 (docs/indie-sources-2026-10.md): products.json is exposed
-- and robots.txt allows it, but their terms of service are the Shopify default template,
-- which forbids "spider, crawl, or scrape". Nothing may ingest until the owner has the store's
-- written OK, records it in metadata.notes and sets data_source.enabled = true per store.
-- enabled=false hides a source from GET /api/ingestion/sources (admin single-job and bulk-run
-- pickers); no timer schedules ingestion.
--
-- Same shape as 20261017062550000_add-indie-shopify-sources: upserted so a row that new code
-- auto-provisioned first (SHOPIFY_SOURCES_PENDING_APPROVAL in
-- src/lib/connectors/shopify-generic.ts) also ends up disabled with the verification notes;
-- metadata is merged so per-source settings under metadata.ingestion are kept. Keep in sync
-- with docs/seed_data_sources.sql.

INSERT INTO data_source (name, source_type, base_url, license, terms_url, enabled, metadata)
VALUES
  (
    'EmilyDeMollyShopify',
    'api',
    'https://emilydemolly.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://emilydemolly.com/policies/terms-of-service',
    false,
    '{"priority": "medium", "mvp": "no", "notes": "Emily de Molly Shopify store (indie, Australia). Verified 2026-10-18: /products.json returns 200 with Shopify products (317 over 2 pages: product_type Nail Polish 234, Stamping Plates 70, Stamping Polish 12, Gift Card 1); the generic connector polish filter accepts 246 (nail and stamping polishes; plates and the gift card dropped). Vendor is Emily de Molly on 313 products and EmilydeMolly on 3. robots.txt is the Shopify default (products.json not disallowed). /policies/terms-of-service is the Shopify default template, whose prohibited uses include: spider, crawl, or scrape. Disabled pending owner approval; enable only after the store gives written OK to read its products.json (record who, when and how here).", "pendingApproval": true, "verification": {"checkedAt": "2026-10-18", "productsJson": true, "products": 317, "polishFilterPass": 246, "robotsTxt": "shopify-default-allows-products-json", "termsScrapingClause": true}}'::jsonb
  ),
  (
    'CirqueColorsShopify',
    'api',
    'https://cirquecolors.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://www.cirquecolors.com/policies/terms-of-service',
    false,
    '{"priority": "medium", "mvp": "no", "notes": "Cirque Colors Shopify store (indie, US). Verified 2026-10-18: /products.json returns 200 with Shopify products (415 over 2 pages). product_type holds finish or line names (Retired Colors 70, Jelly 59, Magnetic 48, Sets 35, Crème 21, Nail Care 13, ...), so the generic connector polish filter accepts only 10 of 415; it needs a store-specific filter (connectors/store-filters/) or the #349 product classifier before ingestion is useful. robots.txt is the Shopify default (products.json not disallowed). /policies/terms-of-service is the Shopify default template, whose prohibited uses include: spider, crawl, or scrape. Disabled pending owner approval; enable only after the store gives written OK to read its products.json (record who, when and how here).", "pendingApproval": true, "verification": {"checkedAt": "2026-10-18", "productsJson": true, "products": 415, "polishFilterPass": 10, "robotsTxt": "shopify-default-allows-products-json", "termsScrapingClause": true}}'::jsonb
  )
ON CONFLICT (name) DO UPDATE
SET
  base_url  = EXCLUDED.base_url,
  license   = EXCLUDED.license,
  terms_url = EXCLUDED.terms_url,
  enabled   = false,
  metadata  = COALESCE(data_source.metadata, '{}'::jsonb) || EXCLUDED.metadata;


-- Down Migration
-- Disable both rows, then remove the ones nothing has run against yet (ingestion_job and
-- external_product cascade on delete, so a row with history is left in place, disabled).
UPDATE data_source SET enabled = false WHERE name IN ('EmilyDeMollyShopify', 'CirqueColorsShopify');

DELETE FROM data_source AS ds
WHERE ds.name IN ('EmilyDeMollyShopify', 'CirqueColorsShopify')
  AND NOT EXISTS (SELECT 1 FROM ingestion_job j WHERE j.data_source_id = ds.data_source_id)
  AND NOT EXISTS (SELECT 1 FROM external_product e WHERE e.data_source_id = ds.data_source_id);
