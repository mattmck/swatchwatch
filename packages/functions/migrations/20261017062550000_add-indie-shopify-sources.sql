-- Up Migration

-- 20261017062550000_add-indie-shopify-sources.sql
-- Registers indie Shopify stores for the generic Shopify connector (#273), DISABLED.
-- Roadmap 2026-10-to-12 decision 4 (which indie sources to ingest) is still open, so
-- nothing may ingest until the owner sets data_source.enabled = true per store.
-- enabled=false hides a source from GET /api/ingestion/sources, which feeds both the
-- single-job and bulk-run pickers in the admin UI; no timer schedules ingestion.
--
-- Each row's metadata.notes records the 2026-10-17 verification (products.json
-- exposed, robots.txt, terms of service); metadata.verification holds the same facts
-- in structured form. Keep in sync with docs/seed_data_sources.sql.
--
-- Upserted so a row that new code auto-provisioned before this migration ran (see
-- SHOPIFY_SOURCES_PENDING_APPROVAL in src/lib/connectors/shopify-generic.ts) also ends
-- up disabled with the verification notes; metadata is merged so per-source ingestion
-- settings under metadata.ingestion are kept.

INSERT INTO data_source (name, source_type, base_url, license, terms_url, enabled, metadata)
VALUES
  (
    'NightOwlLacquerShopify',
    'api',
    'https://nightowllacquer.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://nightowllacquer.com/policies/terms-of-service',
    false,
    '{"priority": "medium", "mvp": "no", "notes": "Night Owl Lacquer Shopify store (indie, US). Verified 2026-10-17: /products.json?limit=1 returns 200 with Shopify products; robots.txt is the Shopify default (User-agent * Allow /, products.json not disallowed; /agents.md asks server-side agents to identify via Web Bot Auth and back off on 429); /policies/terms-of-service has no terms text and /pages/policies-shipping has no automated-access clause. Catalog: product_type Polish (233 of the first 250 products pass the polish filter), vendor is the placeholder vendor-unknown on most products (the connector falls back to the brand Night Owl Lacquer), finishes in plain tags (Creme, Jelly, Crelly, Neon). Disabled pending owner approval (roadmap 2026-10-to-12 decision 4); acceptable use not yet confirmed with the store.", "pendingApproval": true, "verification": {"checkedAt": "2026-10-17", "productsJson": true, "firstPageProducts": 250, "firstPagePolishFilterPass": 233, "robotsTxt": "shopify-default-allows-products-json", "termsScrapingClause": false}}'::jsonb
  ),
  (
    'PahlishShopify',
    'api',
    'https://pahlish.com',
    'Storefront terms apply (verify metadata/image usage obligations)',
    'https://www.pahlish.com/policies/terms-of-service',
    false,
    '{"priority": "medium", "mvp": "no", "notes": "Pahlish Shopify store (indie, US). Verified 2026-10-17: /products.json?limit=1 returns 200 with Shopify products (36 listed: current releases only); robots.txt is the Shopify default (products.json not disallowed); /policies/terms-of-service has no terms text, no automated-access clause found. The generic connector polish filter accepts 0 of the 36 products (empty product_type, tags are collection names only), so ingestion yields nothing until a per-source product filter exists. Disabled pending owner approval (roadmap 2026-10-to-12 decision 4); acceptable use not yet confirmed with the store.", "pendingApproval": true, "verification": {"checkedAt": "2026-10-17", "productsJson": true, "firstPageProducts": 36, "firstPagePolishFilterPass": 0, "robotsTxt": "shopify-default-allows-products-json", "termsScrapingClause": false}}'::jsonb
  )
ON CONFLICT (name) DO UPDATE
SET
  base_url  = EXCLUDED.base_url,
  license   = EXCLUDED.license,
  terms_url = EXCLUDED.terms_url,
  enabled   = false,
  metadata  = COALESCE(data_source.metadata, '{}'::jsonb) || EXCLUDED.metadata;


-- Down Migration

-- Remove the rows unless something already ran against them (ingestion_job and
-- external_product cascade on delete, so a row with history is left in place, disabled).
DELETE FROM data_source AS ds
WHERE ds.name IN ('NightOwlLacquerShopify', 'PahlishShopify')
  AND NOT EXISTS (SELECT 1 FROM ingestion_job j WHERE j.data_source_id = ds.data_source_id)
  AND NOT EXISTS (SELECT 1 FROM external_product e WHERE e.data_source_id = ds.data_source_id);
