-- Up Migration

-- 025_correct_shopify_source_notes.sql
-- Corrects data_source.metadata.notes for Shopify sources, verified on 2026-10-14
-- against each store's public /products.json. None of the 28 Shopify stores expose
-- a real hex value in options, titles or tags; the old notes claiming "hex colors in
-- variant option values" were false.
--
-- Only the "notes" key is replaced (metadata || ...) so per-source ingestion
-- settings stored under metadata.ingestion are preserved.

UPDATE data_source AS ds
SET metadata = COALESCE(ds.metadata, '{}'::jsonb) || jsonb_build_object('notes', v.notes)
FROM (VALUES
  ('HoloTacoShopify', 'Current Holo Taco Shopify storefront pull for recent searchable shades, variant SKU/barcode, and images. Color-family tags (color:blue); no hex values.'),
  ('MooncatShopify', 'Mooncat Shopify store. Rich tags with color-family (color:purple) and finish metadata; no hex values in options, titles or tags.'),
  ('OrlyShopify', 'Orly Beauty Shopify store. Color names only; no hex values in options, titles or tags.'),
  ('BeesKneesLacquerShopify', 'Bees Knees Lacquer Shopify store. Color names only; no hex values in options, titles or tags.'),
  ('GreatLakesLacquerShopify', 'Great Lakes Lacquer Shopify store. Color names only; no hex values in options, titles or tags.'),
  ('KathleenAndCoShopify', 'Kathleen & Co Shopify store. Color names only; no hex values in options, titles or tags.'),
  ('PrismParadeShopify', 'Prism Parade Shopify store. Color names only; no hex values in options, titles or tags.'),
  ('SassysaucePolishShopify', 'Sassysauce Polish Shopify store. Color names only; no hex values in options, titles or tags.'),
  ('LeMiniMacaronShopify', 'Le Mini Macaron Europe Shopify store. Color-family tags (Color_Pink, Color_LS_Blue); no hex values.')
) AS v(name, notes)
WHERE ds.name = v.name;

-- Sources the Shopify connector cannot read. Upserted (not just updated) so that
-- ensureSupportedShopifyDataSources() cannot later auto-provision them as enabled.
INSERT INTO data_source (name, source_type, base_url, license, enabled, metadata)
SELECT
  v.name,
  'api',
  v.base_url,
  'Storefront terms apply (verify metadata/image usage obligations)',
  false,
  jsonb_build_object('priority', 'medium', 'mvp', 'no', 'notes', v.notes)
FROM (VALUES
  ('ClionadhShopify', 'https://clionadhcosmetics.com', 'Clionadh Cosmetics Shopify store. Storefront is password-locked (/products.json returns 401 as of 2026-10-14); disabled.'),
  ('GardenPathLacquersShopify', 'https://gardenpathlacquers.com', 'Garden Path Lacquers Shopify store. Storefront is password-locked (/products.json returns 401 as of 2026-10-14); disabled.'),
  ('RoylaleeShopify', 'https://roylalee.com', 'Roylalee Shopify store. Lists only a gift card as of 2026-10-14; disabled.'),
  ('PotionPolishShopify', 'https://www.potionpolish.com', 'Potion Polish store. Moved to Big Cartel (/products.json returns a bare array with name/permalink as of 2026-10-14), which the Shopify connector cannot read; disabled.')
) AS v(name, base_url, notes)
ON CONFLICT (name) DO UPDATE
SET
  enabled = false,
  metadata = COALESCE(data_source.metadata, '{}'::jsonb) || jsonb_build_object('notes', EXCLUDED.metadata->>'notes');


-- Down Migration

-- Re-enable the four sources disabled above. Notes are left as corrected; the
-- previous text was factually wrong.
UPDATE data_source
SET enabled = true
WHERE name IN ('ClionadhShopify', 'GardenPathLacquersShopify', 'RoylaleeShopify', 'PotionPolishShopify');
