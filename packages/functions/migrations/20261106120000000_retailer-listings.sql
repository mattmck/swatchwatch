-- Up Migration

-- 20261106120000000_retailer-listings.sql
-- Polish Pickup retailer listings (docs/superpowers/plans/2026-11-06-polish-pickup-retailer-listings.md).
--
-- * external_product.missing_since: set when a listing is absent from a complete catalog fetch
--   of its source; NULL = currently listed. Partial index serves "live listings of a source".
-- * shade.catalog_authority: 'brand_store' (default) = catalog data comes from the brand's own
--   store; 'retailer' = the shade was created from a retailer listing and a brand store may
--   take it over.
-- * data_source PolishPickupShopify (retailer), registered DISABLED until the owner records
--   the store's OK in metadata.notes. Keep in sync with docs/seed_data_sources.sql.
-- * brand_alias: Polish Pickup's vendor names that differ from an existing brand only by a
--   suffix (Lacquer, Lacquers, Polish, Polishes, Nail Polish, Cosmetics) map to that brand
--   (e.g. "Bee's Knees" -> "Bee's Knees Lacquer"). Only when no brand already has the vendor's
--   exact name and exactly one suffixed brand exists.

BEGIN;

ALTER TABLE external_product ADD COLUMN IF NOT EXISTS missing_since TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_external_product_live
  ON external_product (data_source_id) WHERE missing_since IS NULL;

ALTER TABLE shade ADD COLUMN IF NOT EXISTS catalog_authority TEXT NOT NULL DEFAULT 'brand_store';
ALTER TABLE shade DROP CONSTRAINT IF EXISTS shade_catalog_authority_check;
ALTER TABLE shade ADD CONSTRAINT shade_catalog_authority_check
  CHECK (catalog_authority IN ('brand_store', 'retailer'));

INSERT INTO data_source (name, source_type, base_url, license, terms_url, enabled, metadata)
VALUES (
  'PolishPickupShopify',
  'api',
  'https://polishpickup.com',
  'Storefront terms apply (verify metadata/image usage obligations)',
  'https://polishpickup.com/policies/terms-of-service',
  false,
  '{"kind": "retailer", "currency": "USD", "priority": "medium", "mvp": "no", "insertedByMigration": "20261106120000000", "pendingApproval": true, "notes": "Polish Pickup: monthly multi-brand indie pre-order shop. Pending owner OK."}'::jsonb
)
ON CONFLICT (name) DO NOTHING;

WITH vendor(name) AS (
  VALUES
    ('1422 Designs'),
    ('Ahmya Cosmetics'),
    ('Alchemy Lacquers'),
    ('All Mixed Up Lacquers'),
    ('Arcana Lacquer'),
    ('Baroness X'),
    ('BCB Lacquers'),
    ('Beaux Rêves Lacquer'),
    ('Bee''s Knees'),
    ('Broken Pixel Polish'),
    ('By Dany Vianna'),
    ('Cadillacquer'),
    ('Cameo Colours Lacquers'),
    ('Chamaeleon Nails'),
    ('Clionadh Cosmetics'),
    ('Colores De Carol'),
    ('Cracked Polish'),
    ('Cupcake Polish'),
    ('Cuticula'),
    ('Dam Nail Polish'),
    ('Danglefoot Nail Polish'),
    ('Dreamland Lacquer'),
    ('DRK Nails'),
    ('Emily de Molly'),
    ('Envy Lacquer'),
    ('Fancy Gloss'),
    ('Garden Path Lacquers'),
    ('Glisten & Glow'),
    ('Haunted Polish'),
    ('Hearts & Promises'),
    ('Hit the Bottle Polishes'),
    ('Humble Bee'),
    ('Indie by Patty Lopes'),
    ('Jen & Berries'),
    ('Jior Couture'),
    ('Kathleen & Co'),
    ('KBShimmer'),
    ('Lemming Lacquer'),
    ('Lumen'),
    ('Lurid Lacquer'),
    ('LynBDesigns'),
    ('ManMade by J&S'),
    ('MJ Lacquer'),
    ('Monarch Lacquer'),
    ('Moon Shine Mani'),
    ('Moth & Moon'),
    ('Nailed It'),
    ('Night Owl Lacquer'),
    ('Nothing Basic'),
    ('Off the Hook Creations by Jessica'),
    ('Pahlish'),
    ('Paint it Pretty Polish'),
    ('Painted Polish'),
    ('Paradox'),
    ('Penelope Luz'),
    ('Phoenix'),
    ('PI Colors'),
    ('Pinnacle Polish'),
    ('Polished For Days'),
    ('Prism Parade'),
    ('Psyche Minerals'),
    ('Raven Lacquer'),
    ('Red Eyed Lacquer'),
    ('Ribbits'),
    ('Rogue Lacquer'),
    ('Royla Lee'),
    ('Sassy Cats Lacquer'),
    ('Sassy Sauce Polish'),
    ('Stella Chroma'),
    ('Sweet & Sour Lacquer'),
    ('sylvanclaw'),
    ('Unicorn Magic Skincare'),
    ('Vibrant Scents'),
    ('Zombie Claw')
),
suffix(s) AS (
  VALUES (' Lacquer'), (' Lacquers'), (' Polish'), (' Polishes'), (' Nail Polish'), (' Cosmetics')
),
candidate AS (
  SELECT v.name AS alias, b.brand_id
  FROM vendor v
  JOIN suffix x ON true
  JOIN brand b ON lower(b.name_canonical) = lower(v.name || x.s)
  WHERE NOT EXISTS (SELECT 1 FROM brand e WHERE lower(e.name_canonical) = lower(v.name))
),
unique_candidate AS (
  SELECT alias, min(brand_id) AS brand_id
  FROM candidate
  GROUP BY alias
  HAVING count(DISTINCT brand_id) = 1
)
INSERT INTO brand_alias (brand_id, alias)
SELECT brand_id, alias FROM unique_candidate
ON CONFLICT DO NOTHING;

COMMIT;

-- Down Migration
-- The alias delete recomputes the set Up inserts. An alias that already existed with the same
-- brand and spelling is indistinguishable from an inserted one and is removed too; that is
-- acceptable because the alias equals a Polish Pickup vendor string for that brand.
-- The data_source row is deleted only when nothing ingested from it (external_product cascades),
-- otherwise it is disabled.

BEGIN;

WITH vendor(name) AS (
  VALUES
    ('1422 Designs'),
    ('Ahmya Cosmetics'),
    ('Alchemy Lacquers'),
    ('All Mixed Up Lacquers'),
    ('Arcana Lacquer'),
    ('Baroness X'),
    ('BCB Lacquers'),
    ('Beaux Rêves Lacquer'),
    ('Bee''s Knees'),
    ('Broken Pixel Polish'),
    ('By Dany Vianna'),
    ('Cadillacquer'),
    ('Cameo Colours Lacquers'),
    ('Chamaeleon Nails'),
    ('Clionadh Cosmetics'),
    ('Colores De Carol'),
    ('Cracked Polish'),
    ('Cupcake Polish'),
    ('Cuticula'),
    ('Dam Nail Polish'),
    ('Danglefoot Nail Polish'),
    ('Dreamland Lacquer'),
    ('DRK Nails'),
    ('Emily de Molly'),
    ('Envy Lacquer'),
    ('Fancy Gloss'),
    ('Garden Path Lacquers'),
    ('Glisten & Glow'),
    ('Haunted Polish'),
    ('Hearts & Promises'),
    ('Hit the Bottle Polishes'),
    ('Humble Bee'),
    ('Indie by Patty Lopes'),
    ('Jen & Berries'),
    ('Jior Couture'),
    ('Kathleen & Co'),
    ('KBShimmer'),
    ('Lemming Lacquer'),
    ('Lumen'),
    ('Lurid Lacquer'),
    ('LynBDesigns'),
    ('ManMade by J&S'),
    ('MJ Lacquer'),
    ('Monarch Lacquer'),
    ('Moon Shine Mani'),
    ('Moth & Moon'),
    ('Nailed It'),
    ('Night Owl Lacquer'),
    ('Nothing Basic'),
    ('Off the Hook Creations by Jessica'),
    ('Pahlish'),
    ('Paint it Pretty Polish'),
    ('Painted Polish'),
    ('Paradox'),
    ('Penelope Luz'),
    ('Phoenix'),
    ('PI Colors'),
    ('Pinnacle Polish'),
    ('Polished For Days'),
    ('Prism Parade'),
    ('Psyche Minerals'),
    ('Raven Lacquer'),
    ('Red Eyed Lacquer'),
    ('Ribbits'),
    ('Rogue Lacquer'),
    ('Royla Lee'),
    ('Sassy Cats Lacquer'),
    ('Sassy Sauce Polish'),
    ('Stella Chroma'),
    ('Sweet & Sour Lacquer'),
    ('sylvanclaw'),
    ('Unicorn Magic Skincare'),
    ('Vibrant Scents'),
    ('Zombie Claw')
),
suffix(s) AS (
  VALUES (' Lacquer'), (' Lacquers'), (' Polish'), (' Polishes'), (' Nail Polish'), (' Cosmetics')
),
candidate AS (
  SELECT v.name AS alias, b.brand_id
  FROM vendor v
  JOIN suffix x ON true
  JOIN brand b ON lower(b.name_canonical) = lower(v.name || x.s)
  WHERE NOT EXISTS (SELECT 1 FROM brand e WHERE lower(e.name_canonical) = lower(v.name))
),
unique_candidate AS (
  SELECT alias, min(brand_id) AS brand_id
  FROM candidate
  GROUP BY alias
  HAVING count(DISTINCT brand_id) = 1
)
DELETE FROM brand_alias ba
USING unique_candidate u
WHERE ba.brand_id = u.brand_id AND ba.alias = u.alias;

DELETE FROM data_source ds
WHERE ds.name = 'PolishPickupShopify'
  AND NOT EXISTS (SELECT 1 FROM external_product ep WHERE ep.data_source_id = ds.data_source_id);

UPDATE data_source SET enabled = false WHERE name = 'PolishPickupShopify';

DROP INDEX IF EXISTS idx_external_product_live;
ALTER TABLE external_product DROP COLUMN IF EXISTS missing_since;

ALTER TABLE shade DROP CONSTRAINT IF EXISTS shade_catalog_authority_check;
ALTER TABLE shade DROP COLUMN IF EXISTS catalog_authority;

COMMIT;
