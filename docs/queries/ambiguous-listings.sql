-- Ambiguous listings — connector products linked to more than one live shade.
--
-- Read-only (one SELECT). Run it on dev and prod before the first reseller or feed job (brand
-- sources plan, owner checklist item 0):
--
--   psql "$DATABASE_URL" -f docs/queries/ambiguous-listings.sql
--
-- Materialization resolves a product's shade through its shade_source_product listing first
-- (findExistingShadeForRecord in packages/functions/src/lib/ingestion-repo.ts, step 0). A product
-- of an enabled source whose listing links several distinct unmerged shades (a merge left two, or
-- an older run linked it twice) is skipped by a reseller/feed source (ambiguousShadesSkipped) and
-- falls back to the brand + name + legacy finish + collection identity for a brand source. Each
-- row below is one such (data_source_id, external_id) pair; fix it by merging the duplicate
-- shades or deleting the stale shade_source_product row.

SELECT
  ds.data_source_id,
  ds.name AS source_name,
  COALESCE(NULLIF(lower(btrim(ds.metadata ->> 'sourceKind')), ''), 'brand') AS source_kind,
  ep.external_id,
  count(DISTINCT sh.shade_id) AS shade_count,
  array_agg(DISTINCT sh.shade_id ORDER BY sh.shade_id) AS shade_ids,
  array_agg(DISTINCT sh.shade_name_canonical ORDER BY sh.shade_name_canonical) AS shade_names
FROM shade_source_product ssp
JOIN external_product ep ON ep.external_product_id = ssp.external_product_id
JOIN data_source ds ON ds.data_source_id = ep.data_source_id
JOIN shade sh ON sh.shade_id = ssp.shade_id
WHERE ds.enabled
  AND sh.merged_into_shade_id IS NULL
GROUP BY ds.data_source_id, ds.name, ds.metadata, ep.external_id
HAVING count(DISTINCT sh.shade_id) > 1
ORDER BY ds.name, ep.external_id;
