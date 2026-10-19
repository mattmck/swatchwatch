-- Catalog hygiene audit — sizes #347 (non-polish products) and #349 (toppers, top coats,
-- base coats, treatments) before any cleanup or schema change. Plan: docs/plan-catalog-hygiene.md.
--
-- Read-only in effect: one transaction that ends in ROLLBACK. Its only write is a session
-- temporary table (Postgres refuses CREATE TABLE AS in a READ ONLY transaction), after which the
-- transaction is switched to read-only, so every report query runs read-only.
-- Run it against the Azure dev database first, prod only after dev looks right (plan §4), and
-- paste the result sets into #347 / #349:
--
--   psql "$DATABASE_URL" -f docs/queries/catalog-hygiene-audit.sql
--
-- How shades are classified. classifyProductCategory in packages/functions/src/lib/product-category.ts
-- applies the same rules in the same order; change this query first, then mirror it there:
--   text       lower-cased shade name + color name + every linked source product's title and
--              product_type ("strong" text), plus its tags ("all" text). Shopify payloads keep
--              these in raw_json; other connectors fall back to the shade name alone.
--              Accessories are decided on strong text only: tags are noisy (Holo Taco tags a
--              magnetic polish "magnetic-wand" because a wand ships with it).
--   category   first match wins, in this order:
--                accessory  stamping plates, buffers, files, tools, brushes, charms, magnets, pushers,
--                           kits, ... in the strong text, or an explicit accessory type tag
--                           (nail-tool, type:nail-tool, type:accessories: Mooncat's "Nail Elixir"
--                           is typed "Nail Polishes" but tagged type:nail-tool)
--                topper     'topper' in finishes/detected_finishes, or the word topper(s) anywhere
--                           (beats coat wording)
--                base_coat  base coat, ridge filler, primer, bonder
--                top_coat   top coat, sealer, quick-dry top
--                treatment  treatment, strengthener, hardener, cuticle oil, growth
--                color      everything else
--   The regexes match whole words (\m ... \M), case-insensitively. Section 6 lists sample rows
--   per category so false positives are easy to spot before trusting the counts.
--
-- Dupe impact (section 4) mirrors the dupe finder: OKLAB distance between display hexes
-- (vendor > detected > name, as resolveDisplayHex), HIGH <= 0.05, MEDIUM <= 0.10
-- (packages/shared/src/color/thresholds.ts). It counts pairs inside each user's owned
-- collection, which is what "you own N near-dupes" is built from.

BEGIN;

CREATE TEMP TABLE audit_shade ON COMMIT DROP AS
WITH source_text AS (
  SELECT
    ssp.shade_id,
    string_agg(DISTINCT ds.name, ', ') AS sources,
    string_agg(
      concat_ws(' ', e.raw_json ->> 'title', e.raw_json ->> 'product_type', e.normalized_json ->> 'productType'),
      ' '
    ) AS strong_text,
    string_agg(
      CASE WHEN jsonb_typeof(e.raw_json -> 'tags') = 'array'
           THEN (SELECT string_agg(t, ' ') FROM jsonb_array_elements_text(e.raw_json -> 'tags') AS t)
           ELSE e.raw_json ->> 'tags' END,
      ' '
    ) AS tag_text,
    -- An explicit accessory type tag (nail-tool, type:nail-tool, type:accessories, ...): a whole
    -- tag that declares the product type, unlike free-form tags such as magnetic-wand.
    bool_or(EXISTS (
      SELECT 1
      FROM (
        SELECT t FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(e.raw_json -> 'tags') = 'array' THEN e.raw_json -> 'tags' ELSE '[]'::jsonb END) AS t
        UNION ALL
        SELECT t FROM regexp_split_to_table(CASE WHEN jsonb_typeof(e.raw_json -> 'tags') = 'string' THEN e.raw_json ->> 'tags' ELSE '' END, ',') AS t
      ) tag
      WHERE lower(trim(tag.t)) ~ '^(type:)?(nail[-_ ]?)?(tools?|accessor(y|ies))$'
    )) AS has_accessory_type_tag,
    string_agg(DISTINCT e.raw_json ->> 'product_type', ', ') AS product_types,
    min(e.raw_json ->> 'title') AS sample_title
  FROM shade_source_product ssp
  JOIN external_product e ON e.external_product_id = ssp.external_product_id
  JOIN data_source ds ON ds.data_source_id = e.data_source_id
  GROUP BY ssp.shade_id
),
base AS (
  SELECT
    s.shade_id,
    b.name_canonical AS brand,
    s.shade_name_canonical AS shade_name,
    s.status,
    s.finishes,
    s.detected_finishes,
    s.vendor_hex,
    s.detected_hex,
    s.detected_hex_method,
    s.color_family,
    -- Same fallback as resolveDisplayHex, which skips empty strings.
    COALESCE(NULLIF(s.vendor_hex, ''), NULLIF(s.detected_hex, ''), NULLIF(s.name_hex, '')) AS display_hex,
    COALESCE(st.sources, '(no source product)') AS sources,
    st.sample_title,
    st.product_types,
    COALESCE(st.has_accessory_type_tag, false) AS has_accessory_type_tag,
    -- strong: name, title and product type. all: strong plus tags (hyphens/underscores as spaces).
    lower(concat_ws(' ', s.shade_name_canonical, s.color_name, st.strong_text)) AS strong_haystack,
    lower(regexp_replace(concat_ws(' ', s.shade_name_canonical, s.color_name, st.strong_text, st.tag_text), '[_-]+', ' ', 'g')) AS haystack
  FROM shade s
  JOIN brand b ON b.brand_id = s.brand_id
  LEFT JOIN source_text st ON st.shade_id = s.shade_id
  WHERE s.merged_into_shade_id IS NULL
)
SELECT
  base.*,
  CASE
    WHEN strong_haystack ~ '\m(stamp(ing|er|ers)?|plates?|buffers?|files?|brush(es)?|tools?|charms?|decals?|stickers?|kits?|jewels?|jewelry|studs?|rhinestones?|foils?|tapes?|stencils?|lamps?|magnets?|wands?|pushers?|clippers?|removers?|wipes?|dehydrators?|racks?|displays?|totes?|gift ?cards?|samplers?|mystery box)\M'
      OR has_accessory_type_tag
      THEN 'accessory'
    -- Topper beats coat wording: Holo Taco files its flakie toppers under product type "Top Coat"
    -- with a "toppers" tag.
    WHEN 'topper' = ANY (finishes) OR 'topper' = ANY (COALESCE(detected_finishes, ARRAY[]::text[]))
      OR haystack ~ '\mtoppers?\M'
      THEN 'topper'
    WHEN haystack ~ '\m(base ?coats?|basecoats?|ridge filler|primer|bonder|bond)\M' THEN 'base_coat'
    WHEN haystack ~ '\m(top ?coats?|topcoats?|sealer|sealant|quick ?dry top)\M' THEN 'top_coat'
    WHEN haystack ~ '\m(treatments?|strengthener|hardener|cuticle oil|cuticle|growth serum)\M' THEN 'treatment'
    ELSE 'color'
  END AS category
FROM base;

CREATE INDEX ON audit_shade (shade_id);

-- From here on nothing can write, temp table included.
SET LOCAL transaction_read_only = on;

-- 1. Size of the problem by category.
--    in_inventory = shades someone holds (any status); those must never be hidden silently.
\echo '== 1. Shades by category'
--    Inventory is collapsed to one row per shade first, so a shade held by many users still
--    counts once in shades / active / with_detected_hex.
WITH holders AS (
  SELECT shade_id, array_agg(DISTINCT user_id) AS user_ids
  FROM user_inventory_item
  WHERE shade_id IS NOT NULL
  GROUP BY shade_id
)
SELECT
  a.category,
  count(*)                                                    AS shades,
  count(*) FILTER (WHERE a.status = 'active')                 AS active,
  count(*) FILTER (WHERE a.detected_hex IS NOT NULL)          AS with_detected_hex,
  count(h.shade_id)                                           AS in_inventory,
  (SELECT count(DISTINCT u)
     FROM audit_shade a2
     JOIN holders h2 ON h2.shade_id = a2.shade_id
     CROSS JOIN LATERAL unnest(h2.user_ids) AS u
    WHERE a2.category = a.category)                           AS users_holding
FROM audit_shade a
LEFT JOIN holders h ON h.shade_id = a.shade_id
GROUP BY a.category
ORDER BY shades DESC;

-- 2. Where the non-color shades come from (which connectors need the stricter filter).
\echo '== 2. Non-color shades by source'
SELECT a.sources, a.category, count(*) AS shades
FROM audit_shade a
WHERE a.category <> 'color'
GROUP BY a.sources, a.category
ORDER BY shades DESC
LIMIT 40;

-- 3. Toppers by color family. Toppers bunched into white/grey/nude are the ones most likely
--    to show up as false dupes of light polishes.
\echo '== 3. Toppers by color family and hex source'
SELECT
  COALESCE(a.color_family, '(none)')                          AS color_family,
  count(*)                                                    AS toppers,
  count(*) FILTER (WHERE a.vendor_hex IS NOT NULL)            AS vendor_hex,
  count(*) FILTER (WHERE a.vendor_hex IS NULL AND a.detected_hex IS NOT NULL) AS detected_only,
  count(*) FILTER (WHERE a.display_hex IS NULL)               AS no_hex
FROM audit_shade a
WHERE a.category = 'topper'
GROUP BY 1
ORDER BY toppers DESC;

-- 4. Dupe exposure: near-dupe pairs inside each user's owned collection where at least one
--    side is not a color polish (topper vs color, topper vs topper, coat vs color, ...), each
--    pair counted once, split by grade and by the color side's family.
--    This measures the data, not the dupe finder's output. Adding categories doesn't change
--    hex distances, but clearing a topper's detected_hex (plan D-D) moves or removes that
--    topper's pairs, so save this section before a backfill and compare after (plan §4 Phase 6).
--    It sizes how many warnings toppers and coats can cause today; Phase 6 verifies the dupe
--    finder separately.
\echo '== 4. Owned near-dupe pairs involving non-color shades'
WITH owned AS (
  SELECT i.user_id, a.shade_id, a.category, a.display_hex, a.color_family
  FROM user_inventory_item i
  JOIN audit_shade a ON a.shade_id = i.shade_id
  WHERE i.status IN ('owned', 'destash') AND a.display_hex IS NOT NULL
),
pairs AS (
  SELECT
    x.user_id,
    least(x.category, y.category)    AS category_a,
    greatest(x.category, y.category) AS category_b,
    CASE WHEN x.category = 'color' THEN x.color_family
         WHEN y.category = 'color' THEN y.color_family END AS color_side_family,
    hex_oklab_distance(x.display_hex, y.display_hex) AS distance
  FROM owned x
  JOIN owned y ON y.user_id = x.user_id AND x.shade_id < y.shade_id
  WHERE x.category <> 'color' OR y.category <> 'color'
)
SELECT
  category_a,
  category_b,
  COALESCE(color_side_family, '-')         AS color_side_family,
  count(*) FILTER (WHERE distance <= 0.05) AS high_pairs,
  count(*) FILTER (WHERE distance > 0.05 AND distance <= 0.10) AS medium_pairs,
  count(DISTINCT user_id) FILTER (WHERE distance <= 0.10) AS users_affected
FROM pairs
GROUP BY 1, 2, 3
HAVING count(*) FILTER (WHERE distance <= 0.10) > 0
ORDER BY count(*) FILTER (WHERE distance <= 0.10) DESC
LIMIT 30;

-- 4b. Every owned near-dupe pair with a non-color side, one row per pair, unaggregated and
--     untruncated, for the Phase 6 before/after comparison (plan §4). Save it to a file before
--     the backfill and diff it after. It holds internal user ids, so keep it out of issues and
--     PR comments; post section 4's totals there instead.
\echo '== 4b. All owned near-dupe pairs with a non-color side (for Phase 6; do not post)'
WITH owned AS (
  SELECT i.user_id, a.shade_id, a.category, a.display_hex
  FROM user_inventory_item i
  JOIN audit_shade a ON a.shade_id = i.shade_id
  WHERE i.status IN ('owned', 'destash') AND a.display_hex IS NOT NULL
)
SELECT
  x.user_id,
  x.shade_id AS shade_a, x.category AS category_a, x.display_hex AS hex_a,
  y.shade_id AS shade_b, y.category AS category_b, y.display_hex AS hex_b,
  round(hex_oklab_distance(x.display_hex, y.display_hex)::numeric, 4) AS distance,
  CASE WHEN hex_oklab_distance(x.display_hex, y.display_hex) <= 0.05 THEN 'HIGH' ELSE 'MEDIUM' END AS grade
FROM owned x
JOIN owned y ON y.user_id = x.user_id AND x.shade_id < y.shade_id
WHERE (x.category <> 'color' OR y.category <> 'color')
  AND hex_oklab_distance(x.display_hex, y.display_hex) <= 0.10
ORDER BY x.user_id, x.shade_id, y.shade_id;

-- 5. Toppers whose detected hex may be the base color underneath: the detected hex is far
--    from the vendor hex, or there is no vendor hex and the detected hex is saturated (a
--    clear-based topper should read near white/grey, not as a strong color).
\echo '== 5. Toppers with a suspicious detected hex (sample)'
SELECT
  a.shade_id, a.brand, a.shade_name, a.vendor_hex, a.detected_hex,
  round(hex_oklab_distance(a.vendor_hex, a.detected_hex)::numeric, 3) AS vendor_vs_detected,
  a.detected_hex_method, a.color_family
FROM audit_shade a
WHERE a.category = 'topper'
  AND a.detected_hex IS NOT NULL
  AND (
    hex_oklab_distance(a.vendor_hex, a.detected_hex) > 0.10
    -- Family of the detected hex itself (color_family can come from finish metadata);
    -- an unparseable hex is suspicious too.
    OR (a.vendor_hex IS NULL
        AND COALESCE(shade_color_family_from_hex(a.detected_hex), '') NOT IN ('white', 'grey', 'nude'))
  )
ORDER BY vendor_vs_detected DESC NULLS LAST
LIMIT 40;

-- 6. Samples per non-color category, to check the regexes for false positives before trusting
--    sections 1-5. Ten rows each, newest first by id.
\echo '== 6. Sample rows per category'
SELECT category, shade_id, brand, shade_name, left(COALESCE(sample_title, ''), 50) AS source_title, product_types, sources, status
FROM (
  SELECT a.*, row_number() OVER (PARTITION BY a.category ORDER BY a.shade_id DESC) AS rn
  FROM audit_shade a
  WHERE a.category <> 'color'
) ranked
WHERE rn <= 10
ORDER BY category, shade_id DESC;

ROLLBACK;
