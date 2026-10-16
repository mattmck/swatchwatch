-- Up Migration

-- 20261016030127700_clear-fake-shopify-vendor-hex.sql
-- Clears shade.vendor_hex values that the generic Shopify connector invented.
--
-- No Shopify store publishes real hex values (MakeupAPI is the only source with real
-- vendor hex data). Before PR #238 the connector's HEX_COLOR_REGEX was
-- /#?([0-9A-Fa-f]{6})/, which matched six hex letters inside ordinary product
-- titles/options: "Facade" -> #FACADE, "Chewiebacca" -> #EBACCA, "Decade" -> #DECADE.
-- Shopify-sourced shades also picked up the placeholder values #000000 and #D3D3D3.
--
-- A shade is Shopify-sourced when the ingestion user's inventory row is tagged
-- 'shopify' (with an "Imported from ..." note) or its swatch image is owned by a
-- *Shopify data_source. Shades linked to MakeupAPI are never touched.
--
-- vendor_hex is cleared (detected_hex/name_hex are left alone) when either:
--   * regex_false_positive: the hex digits appear (case-insensitively) in the shade
--     name, color name, or the stored raw Shopify title/option values, but never as
--     a literal "#RRGGBB" token — i.e. the fixed regex /#([0-9A-Fa-f]{6})\b/ would
--     not have produced it; or
--   * placeholder: vendor_hex is #000000 or #D3D3D3 (skipped for user-created shades,
--     where the user may have entered it).
--
-- Old values are stashed in shade_vendor_hex_cleanup_backup so the down migration
-- can restore them.

BEGIN;

CREATE TABLE IF NOT EXISTS shade_vendor_hex_cleanup_backup (
  shade_id BIGINT PRIMARY KEY REFERENCES shade(shade_id) ON DELETE CASCADE,
  vendor_hex TEXT NOT NULL,
  reason TEXT NOT NULL,
  cleared_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

WITH shopify_source AS (
  SELECT data_source_id
  FROM data_source
  WHERE name ILIKE '%shopify'
),
shopify_import AS (
  SELECT ui.shade_id, substring(ui.notes FROM 'external_id=(\S+)') AS external_id
  FROM user_inventory_item ui
  WHERE ui.tags @> ARRAY['shopify']::text[]
    AND ui.notes LIKE 'Imported from %'
),
shopify_shade AS (
  SELECT shade_id FROM shopify_import
  UNION
  SELECT sw.shade_id
  FROM swatch sw
  JOIN image_asset ia ON ia.image_id = sw.image_id_original AND ia.owner_type = 'source'
  WHERE ia.owner_id IN (SELECT data_source_id FROM shopify_source)
),
makeup_shade AS (
  SELECT ui.shade_id
  FROM user_inventory_item ui
  WHERE ui.tags @> ARRAY['makeupapi']::text[]
  UNION
  SELECT sw.shade_id
  FROM swatch sw
  JOIN image_asset ia ON ia.image_id = sw.image_id_original AND ia.owner_type = 'source'
  JOIN data_source ds ON ds.data_source_id = ia.owner_id
  WHERE ds.name = 'MakeupAPI'
),
-- Raw Shopify title + variant option values, i.e. the strings the old regex scanned.
raw_text AS (
  SELECT
    si.shade_id,
    string_agg(
      concat_ws(E'\n',
        ep.raw_json->>'title',
        (SELECT string_agg(concat_ws(E'\n', v->>'option1', v->>'option2', v->>'option3'), E'\n')
           FROM jsonb_array_elements(
             CASE WHEN jsonb_typeof(ep.raw_json->'variants') = 'array'
                  THEN ep.raw_json->'variants' ELSE '[]'::jsonb END
           ) AS v)
      ),
      E'\n'
    ) AS txt
  FROM shopify_import si
  JOIN external_product ep
    ON ep.external_id = si.external_id
   AND ep.data_source_id IN (SELECT data_source_id FROM shopify_source)
  GROUP BY si.shade_id
),
candidate AS (
  SELECT
    s.shade_id,
    s.vendor_hex,
    s.created_by_user_id,
    upper(substr(btrim(s.vendor_hex), 2)) AS digits,
    concat_ws(E'\n', s.shade_name_canonical, s.color_name, rt.txt) AS haystack
  FROM shade s
  JOIN shopify_shade ss ON ss.shade_id = s.shade_id
  LEFT JOIN raw_text rt ON rt.shade_id = s.shade_id
  WHERE s.vendor_hex IS NOT NULL
    AND s.shade_id NOT IN (SELECT shade_id FROM makeup_shade WHERE shade_id IS NOT NULL)
),
classified AS (
  SELECT
    shade_id,
    vendor_hex,
    CASE
      WHEN digits IN ('000000', 'D3D3D3') AND created_by_user_id IS NULL
        THEN 'placeholder'
      WHEN btrim(vendor_hex) ~* '^#[0-9a-f]{6}$'
        AND strpos(upper(haystack), digits) > 0
        AND haystack !~* ('#' || digits || '([^0-9a-z_]|$)')
        THEN 'regex_false_positive'
    END AS reason
  FROM candidate
)
INSERT INTO shade_vendor_hex_cleanup_backup (shade_id, vendor_hex, reason)
SELECT shade_id, vendor_hex, reason
FROM classified
WHERE reason IS NOT NULL
ON CONFLICT (shade_id) DO NOTHING;

UPDATE shade s
SET vendor_hex = NULL
FROM shade_vendor_hex_cleanup_backup b
WHERE s.shade_id = b.shade_id
  AND s.vendor_hex = b.vendor_hex;

COMMIT;

-- Down Migration

BEGIN;

-- Restore only rows that are still empty, so values written by later ingestion runs win.
UPDATE shade s
SET vendor_hex = b.vendor_hex
FROM shade_vendor_hex_cleanup_backup b
WHERE s.shade_id = b.shade_id
  AND s.vendor_hex IS NULL;

DROP TABLE IF EXISTS shade_vendor_hex_cleanup_backup;

COMMIT;
