-- Retailer duplicates — shades a retailer source may have created next to a brand store's shade,
-- and brands it may have created next to an existing brand.
--
-- Read-only (two SELECTs). Run it after the first dry run of a retailer source (Beyond Polish,
-- Harlow & Co, Hypnotic Polish) and again after the first real run:
--
--   psql "$DATABASE_URL" -f docs/queries/retailer-duplicates.sql
--
-- Needs pg_trgm (similarity()). A retailer record adopts the brand's shade when the names match
-- (findExistingShadeForRecord); these queries find what slipped through: spelling differences,
-- sizes or codes left in a name, a brand spelled two ways. Fix a pair by merging the shades
-- (mergeShadeInto) or aliasing the vendor in data_source.metadata.vendorAliases.

-- Part 1: pairs of active, unmerged shades of one brand whose names are equal after stripping a
-- size ("0.5 oz") and a trailing "#code", or within similarity() > 0.85, with their sources.
WITH named AS (
  SELECT
    sh.shade_id,
    sh.brand_id,
    sh.shade_name_canonical AS name,
    sh.catalog_authority,
    btrim(regexp_replace(
      regexp_replace(lower(sh.shade_name_canonical), '\s*\(?\d*\.?\d+\s*(oz|ml)\.?\)?', '', 'g'),
      '\s*#\s*[a-z0-9][a-z0-9.-]*\s*$', '')) AS key
  FROM shade sh
  WHERE sh.status = 'active'
    AND sh.merged_into_shade_id IS NULL
)
SELECT
  b.name_canonical AS brand,
  a.shade_id AS shade_a,
  a.name AS name_a,
  a.catalog_authority AS authority_a,
  z.shade_id AS shade_b,
  z.name AS name_b,
  z.catalog_authority AS authority_b,
  round(similarity(a.name, z.name)::numeric, 3) AS name_similarity,
  (SELECT array_agg(DISTINCT ds.name ORDER BY ds.name)
     FROM shade_source_product ssp
     JOIN external_product ep ON ep.external_product_id = ssp.external_product_id
     JOIN data_source ds ON ds.data_source_id = ep.data_source_id
    WHERE ssp.shade_id IN (a.shade_id, z.shade_id)) AS sources
FROM named a
JOIN named z ON z.brand_id = a.brand_id AND z.shade_id > a.shade_id
JOIN brand b ON b.brand_id = a.brand_id
WHERE a.key = z.key OR similarity(a.name, z.name) > 0.85
ORDER BY b.name_canonical, name_similarity DESC, a.shade_id;

-- Part 2: brands that only retailer-authority shades use (a retailer source created them) whose
-- name is within similarity() > 0.8 of another brand: usually one brand spelled two ways, fixed
-- with a vendorAliases entry on the source and a brand merge.
SELECT
  rb.brand_id AS retailer_brand_id,
  rb.name_canonical AS retailer_brand,
  ob.brand_id AS other_brand_id,
  ob.name_canonical AS other_brand,
  round(similarity(rb.name_canonical, ob.name_canonical)::numeric, 3) AS name_similarity
FROM brand rb
JOIN brand ob ON ob.brand_id <> rb.brand_id
WHERE EXISTS (SELECT 1 FROM shade s WHERE s.brand_id = rb.brand_id)
  AND NOT EXISTS (SELECT 1 FROM shade s WHERE s.brand_id = rb.brand_id AND s.catalog_authority <> 'retailer')
  AND similarity(rb.name_canonical, ob.name_canonical) > 0.8
ORDER BY name_similarity DESC, rb.name_canonical, ob.name_canonical;
