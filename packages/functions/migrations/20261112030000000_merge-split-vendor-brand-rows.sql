-- Up Migration

-- 20261112030000000_merge-split-vendor-brand-rows.sql
-- Two brands are split over two rows on the dev database: the seeded canonical row
-- ("Bee's Knees Lacquer", "Loud Lacquer") is empty, and every shade sits on a second row named
-- after the store's vendor spelling ("Bee's Knees", "LOUD") that an early ingest created.
-- Migration 20261106120000000 seeds the alias vendor -> canonical only when no brand already has
-- the vendor's exact name, so it skipped these, and a vendor resolves by exact name before aliases
-- (ingestion-repo.ts), so an alias alone would not move anything.
--
-- For each listed pair:
-- * both rows exist and the canonical one holds nothing (no shade, sku or product line): its
--   aliases and ingest profile move to the vendor row, the empty row is deleted, and the vendor
--   row takes the canonical name. Shades keep their brand_id, so nothing else is rewritten.
-- * only the vendor row exists: it takes the canonical name.
-- * the canonical row holds data too: nothing is changed (NOTICE); an admin has to merge by hand.
-- In every handled case the vendor spelling ends up as a brand_alias of the canonical row, which
-- is all a database that never had the split needs. Idempotent.

DO $$
DECLARE
  pair RECORD;
  vendor_id BIGINT;
  canonical_id BIGINT;
BEGIN
  FOR pair IN
    SELECT * FROM (VALUES
      ('Bee''s Knees', 'Bee''s Knees Lacquer'),
      ('LOUD', 'Loud Lacquer')
    ) AS v(vendor_name, canonical_name)
  LOOP
    SELECT brand_id INTO vendor_id FROM brand WHERE name_canonical = pair.vendor_name;
    SELECT brand_id INTO canonical_id FROM brand WHERE name_canonical = pair.canonical_name;

    IF vendor_id IS NULL THEN
      IF canonical_id IS NOT NULL THEN
        INSERT INTO brand_alias (brand_id, alias)
        VALUES (canonical_id, pair.vendor_name)
        ON CONFLICT (brand_id, alias) DO NOTHING;
      END IF;
      CONTINUE;
    END IF;

    IF canonical_id IS NOT NULL THEN
      IF EXISTS (SELECT 1 FROM shade WHERE brand_id = canonical_id)
         OR EXISTS (SELECT 1 FROM sku WHERE brand_id = canonical_id)
         OR EXISTS (SELECT 1 FROM product_line WHERE brand_id = canonical_id) THEN
        RAISE NOTICE 'brand rows "%" and "%" both hold data; not merged', pair.vendor_name, pair.canonical_name;
        CONTINUE;
      END IF;

      INSERT INTO brand_alias (brand_id, alias)
      SELECT vendor_id, alias FROM brand_alias WHERE brand_id = canonical_id
      ON CONFLICT (brand_id, alias) DO NOTHING;
      DELETE FROM brand_alias WHERE brand_id = canonical_id;

      UPDATE brand_ingest_profile
      SET brand_id = vendor_id
      WHERE brand_id = canonical_id
        AND NOT EXISTS (SELECT 1 FROM brand_ingest_profile WHERE brand_id = vendor_id);

      -- Any profile left on the empty row goes with it (ON DELETE CASCADE).
      DELETE FROM brand WHERE brand_id = canonical_id;
    END IF;

    UPDATE brand SET name_canonical = pair.canonical_name WHERE brand_id = vendor_id;
    DELETE FROM brand_alias WHERE brand_id = vendor_id AND lower(alias) = lower(pair.canonical_name);
    INSERT INTO brand_alias (brand_id, alias)
    VALUES (vendor_id, pair.vendor_name)
    ON CONFLICT (brand_id, alias) DO NOTHING;
  END LOOP;
END $$;

-- Down Migration

-- Not reversible: the deleted row was empty, and splitting the brand again would only recreate
-- the fault. The aliases this adds are harmless to keep.
