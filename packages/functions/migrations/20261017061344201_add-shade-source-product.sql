-- Up Migration

-- 20261017061344201_add-shade-source-product.sql
-- Links each shade to the connector product record(s) (external_product) it was
-- materialized from, so the API can expose a "Buy from brand" link (#267) from the
-- stored product URL (external_product.normalized_json ->> 'productUrl').
--
-- * The URL itself stays in external_product (single source of truth; refreshed on
--   every ingestion upsert). This table only records which products a shade came from.
-- * last_seen_at is bumped every time ingestion materializes the shade from that
--   product again; the read side prefers an enabled data_source, then the most
--   recently seen link (see packages/functions/src/lib/buy-link.ts).
-- * Backfill: shades already materialized before this migration are matched to their
--   products the way ingestion resolves them (brand + shade name [+ finish/collection]
--   for Shopify sources, brand + product name = shade collection for MakeupAPI).
--   It is a best-effort link; the next ingestion run records exact links.
-- Every statement is idempotent so the migration is safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS shade_source_product (
  shade_id BIGINT NOT NULL REFERENCES shade(shade_id) ON DELETE CASCADE,
  external_product_id BIGINT NOT NULL REFERENCES external_product(external_product_id) ON DELETE CASCADE,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (shade_id, external_product_id)
);

CREATE INDEX IF NOT EXISTS idx_shade_source_product_external_product
  ON shade_source_product(external_product_id);

-- Shopify sources (HoloTacoShopify + generic Shopify stores): one product → one shade,
-- keyed like materializePreparedHoloTacoRecord (brand, name, first finish, first collection).
-- HoloTacoShopify omits the brand, so only that source falls back to 'Holo Taco'.
INSERT INTO shade_source_product (shade_id, external_product_id, first_seen_at, last_seen_at)
SELECT s.shade_id, ep.external_product_id, ep.fetched_at, ep.fetched_at
FROM external_product ep
JOIN data_source ds ON ds.data_source_id = ep.data_source_id
JOIN brand b
  ON lower(b.name_canonical) = lower(COALESCE(
       NULLIF(trim(ep.normalized_json ->> 'brand'), ''),
       CASE WHEN ds.name = 'HoloTacoShopify' THEN 'Holo Taco' END
     ))
JOIN shade s
  ON s.brand_id = b.brand_id
 AND s.product_line_id IS NULL
 AND lower(s.shade_name_canonical) = lower(NULLIF(trim(ep.normalized_json ->> 'name'), ''))
 AND COALESCE(s.finish, '') = COALESCE(NULLIF(trim(ep.normalized_json -> 'finishes' ->> 0), ''), '')
 AND COALESCE(s.collection, '') = COALESCE(NULLIF(trim(ep.normalized_json -> 'collections' ->> 0), ''), '')
WHERE ds.name LIKE '%Shopify'
ON CONFLICT (shade_id, external_product_id) DO NOTHING;

-- MakeupAPI: one product → one shade per color variant, with collection = product name.
INSERT INTO shade_source_product (shade_id, external_product_id, first_seen_at, last_seen_at)
SELECT s.shade_id, ep.external_product_id, ep.fetched_at, ep.fetched_at
FROM external_product ep
JOIN data_source ds ON ds.data_source_id = ep.data_source_id
JOIN brand b
  ON lower(b.name_canonical) = lower(NULLIF(trim(ep.normalized_json ->> 'brand'), ''))
JOIN shade s
  ON s.brand_id = b.brand_id
 AND s.product_line_id IS NULL
 AND lower(COALESCE(s.collection, '')) = lower(NULLIF(trim(ep.normalized_json ->> 'name'), ''))
WHERE ds.name = 'MakeupAPI'
ON CONFLICT (shade_id, external_product_id) DO NOTHING;

COMMIT;

-- Down Migration

BEGIN;

DROP TABLE IF EXISTS shade_source_product;

COMMIT;
