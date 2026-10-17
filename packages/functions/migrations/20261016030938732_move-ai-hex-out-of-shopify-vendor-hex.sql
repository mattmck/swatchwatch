-- Up Migration

-- Moves AI-detected hex values out of shade.vendor_hex on Shopify-sourced shades.
--
-- Before migration 011 there was one user_inventory_item.color_hex column. The Holo
-- Taco Shopify connector filled it only with the Azure OpenAI vision result for the
-- product image (detectHexWithAzureOpenAI); Shopify publishes no hex for these
-- products. Migration 011 copied every color_hex into vendor_hex and 012 moved it to
-- shade, so those AI values now look like vendor data. MakeupAPI is the only source
-- with real vendor hex values.
--
-- Shopify-sourced and MakeupAPI-linked shades are found the same way as in
-- 20261016030127700_clear-fake-shopify-vendor-hex.sql. A vendor_hex is moved when the
-- connector's regex could not have produced it: the hex digits appear nowhere
-- (case-insensitively) in the shade name, color name or the stored raw Shopify title
-- and variant options. That leaves out real "#RRGGBB" tokens and the regex false
-- positives the earlier migration handles. The #000000/#D3D3D3 placeholders and
-- user-created shades are also left alone.
--
-- detected_hex takes the value when it is empty; when it already holds a newer AI
-- result, vendor_hex is only cleared. Old values are stashed in
-- shade_vendor_hex_to_detected_backup so the down migration can restore them.

BEGIN;

CREATE TABLE IF NOT EXISTS shade_vendor_hex_to_detected_backup (
  shade_id BIGINT PRIMARY KEY REFERENCES shade(shade_id) ON DELETE CASCADE,
  vendor_hex TEXT NOT NULL,
  detected_hex TEXT,
  moved_at TIMESTAMPTZ NOT NULL DEFAULT now()
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
-- Raw Shopify title + variant option values, i.e. the strings the connector regex scans.
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
    s.detected_hex,
    upper(substr(btrim(s.vendor_hex), 2)) AS digits,
    concat_ws(E'\n', s.shade_name_canonical, s.color_name, rt.txt) AS haystack
  FROM shade s
  JOIN shopify_shade ss ON ss.shade_id = s.shade_id
  LEFT JOIN raw_text rt ON rt.shade_id = s.shade_id
  WHERE s.vendor_hex IS NOT NULL
    AND s.created_by_user_id IS NULL
    AND btrim(s.vendor_hex) ~* '^#[0-9a-f]{6}$'
    AND s.shade_id NOT IN (SELECT shade_id FROM makeup_shade WHERE shade_id IS NOT NULL)
)
INSERT INTO shade_vendor_hex_to_detected_backup (shade_id, vendor_hex, detected_hex)
SELECT shade_id, vendor_hex, detected_hex
FROM candidate
WHERE digits NOT IN ('000000', 'D3D3D3')
  AND strpos(upper(haystack), digits) = 0
ON CONFLICT (shade_id) DO NOTHING;

UPDATE shade s
SET detected_hex = COALESCE(s.detected_hex, b.vendor_hex),
    vendor_hex = NULL
FROM shade_vendor_hex_to_detected_backup b
WHERE s.shade_id = b.shade_id
  AND s.vendor_hex = b.vendor_hex;

COMMIT;

-- Down Migration

BEGIN;

-- Undo detected_hex only where this migration set it and nothing has changed it since.
UPDATE shade s
SET detected_hex = NULL
FROM shade_vendor_hex_to_detected_backup b
WHERE s.shade_id = b.shade_id
  AND b.detected_hex IS NULL
  AND s.detected_hex = b.vendor_hex;

-- Restore only rows that are still empty, so values written by later ingestion runs win.
UPDATE shade s
SET vendor_hex = b.vendor_hex
FROM shade_vendor_hex_to_detected_backup b
WHERE s.shade_id = b.shade_id
  AND s.vendor_hex IS NULL;

DROP TABLE IF EXISTS shade_vendor_hex_to_detected_backup;

COMMIT;
