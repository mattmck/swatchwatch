-- Up Migration

-- 20261108140000000_add-hypnotic-polish-source.sql
-- Registers Hypnotic Polish (hypnoticpolish.com, EU multi-brand retailer, EUR) DISABLED and
-- PENDING as a retailer source (metadata.kind = 'retailer'; brand sources plan, Task 8). Its
-- terms carry the Shopify default clause (spider, crawl, or scrape), so it stays off until the
-- owner records the store's written OK in metadata.notes (spec section 7). It is in
-- SHOPIFY_SOURCES_PENDING_APPROVAL, so code that reaches an environment first provisions it
-- disabled too. imagesPermitted is left unset (false for a retailer).
-- Store filter: src/lib/connectors/store-filters/hypnotic-polish.ts. Keep in sync with
-- docs/seed_data_sources.sql.
--
-- Insert only: ON CONFLICT DO NOTHING, so an existing row (auto-provisioned, or enabled by the
-- owner later) is never changed, enabled or disabled. Rollback safety (the #394 / #398 pattern):
-- a row this migration INSERTS is stamped metadata.insertedByMigration; the Down section deletes
-- only a stamped row without ingestion history, and disables a stamped row that has history.

BEGIN;

INSERT INTO data_source (name, source_type, base_url, license, terms_url, enabled, metadata)
VALUES
  (
    'HypnoticPolishShopify',
    'api',
    'https://www.hypnoticpolish.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://www.hypnoticpolish.com/policies/terms-of-service',
    false,
    '{"kind": "retailer", "currency": "EUR", "vendorAliases": {"Cuticula Nail Lacquer": "Cuticula", "Bee''s Knees Lacquer": "Bee''s Knees"}, "pendingApproval": true, "priority": "medium", "mvp": "no", "notes": "Hypnotic Polish Shopify store (EU multi-brand retailer, EUR). Verified 2026-11-08: /products.json returns 200 with Shopify products (998 over 4 pages of 250, 16 vendors). robots.txt is the Shopify default (products.json not disallowed). /policies/terms-of-service carries the Shopify default template, whose prohibited uses include: spider, crawl, or scrape. REGISTERED DISABLED AND PENDING: needs the store''s written OK before it is enabled; record it here as ''Acceptable use confirmed by <name, role> at Hypnotic Polish on <date> via <channel>: <summary>'', then set enabled = true and remove pendingApproval. The generic polish gate accepts 977 of the 998; headline brands (accepted listings): ILNP 308, Cirque Colors 201, KBShimmer 110, Cosmic Polish 73, Cuticula 68, Emily de Molly 58, Bee''s Knees 49, Starrily 49, Cadillacquer 40. The store filter connectors/store-filters/hypnotic-polish.ts drops the Cuticle Treatment and Accessories product types and grab bag / mystery listings; coats and toppers go through the generic gate with their category. Registered as a retailer (metadata.kind = retailer): listings adopt the brand stores'' shades and only fill empty data; vendorAliases map the store''s vendor spellings to brands; images stay off until metadata.imagesPermitted is set after the store''s OK.", "verification": {"checkedAt": "2026-11-08", "productsJson": true, "products": 998, "vendors": 16, "genericGateAccepts": 977, "robotsTxt": "shopify-default-allows-products-json", "termsScrapingClause": true, "writtenPermission": null}, "insertedByMigration": "20261108140000000"}'::jsonb
  )
ON CONFLICT (name) DO NOTHING;

COMMIT;


-- Down Migration
-- Remove the row only if Up inserted it and nothing ran against it (ingestion_job and
-- external_product cascade on delete, so a row with history is left in place, disabled).
BEGIN;

UPDATE data_source
SET enabled = false
WHERE name = 'HypnoticPolishShopify'
  AND metadata->>'insertedByMigration' = '20261108140000000';

DELETE FROM data_source AS ds
WHERE ds.name = 'HypnoticPolishShopify'
  AND ds.metadata->>'insertedByMigration' = '20261108140000000'
  AND NOT EXISTS (SELECT 1 FROM ingestion_job j WHERE j.data_source_id = ds.data_source_id)
  AND NOT EXISTS (SELECT 1 FROM external_product e WHERE e.data_source_id = ds.data_source_id);

COMMIT;
