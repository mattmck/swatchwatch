-- Up Migration

-- 20261019012116681_barcode-provenance-and-user-barcodes.sql
-- Barcode scans match the catalog end to end (#21, #325).
--
-- * barcode: catalog GTINs, written by ingestion materialization and the admin backfill
--   (packages/functions/src/lib/barcodes.ts). `gtin` stays globally UNIQUE (one GTIN → one
--   SKU → one shade; the first shade to claim a GTIN keeps it and conflicts are logged).
--   New provenance columns record who wrote the row and from which connector product.
-- * user_shade_barcode: GTINs a user taught the app through Rapid Add ("unknown barcode"
--   → label photo → match, or a manual add carrying the scanned code). Private to that user
--   (PRIMARY KEY (user_id, gtin), always queried with user_id): a user's scan never changes
--   what other users' scans resolve to, and catalog barcode rows win over it.
-- * idx_external_product_gtin_compact: the capture resolver's fallback matches a scanned code
--   against connector products' raw GTIN (spaces/hyphens removed) through shade_source_product
--   until the backfill has written barcode rows.
-- Every statement is idempotent; see docs/schema.sql.

BEGIN;

ALTER TABLE barcode ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE barcode ADD COLUMN IF NOT EXISTS external_product_id BIGINT
  REFERENCES external_product(external_product_id) ON DELETE SET NULL;
ALTER TABLE barcode ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'barcode_source_check') THEN
    ALTER TABLE barcode ADD CONSTRAINT barcode_source_check
      CHECK (source IN ('ingestion', 'backfill', 'admin', 'unknown'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_barcode_sku ON barcode(sku_id);

CREATE INDEX IF NOT EXISTS idx_external_product_gtin_compact
  ON external_product ((regexp_replace(gtin, '[[:space:]-]', '', 'g')))
  WHERE gtin IS NOT NULL;

CREATE TABLE IF NOT EXISTS user_shade_barcode (
  user_id BIGINT NOT NULL REFERENCES app_user(user_id) ON DELETE CASCADE,
  gtin TEXT NOT NULL,                          -- canonical key (lib/barcodes.ts normalizeGtin)
  shade_id BIGINT NOT NULL REFERENCES shade(shade_id) ON DELETE CASCADE,
  barcode_type TEXT,
  capture_session_id BIGINT REFERENCES capture_session(capture_session_id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, gtin)
);

CREATE INDEX IF NOT EXISTS idx_user_shade_barcode_shade ON user_shade_barcode(shade_id);

COMMIT;

-- Down Migration

BEGIN;

DROP TABLE IF EXISTS user_shade_barcode;
DROP INDEX IF EXISTS idx_external_product_gtin_compact;
DROP INDEX IF EXISTS idx_barcode_sku;
ALTER TABLE barcode DROP CONSTRAINT IF EXISTS barcode_source_check;
ALTER TABLE barcode DROP COLUMN IF EXISTS created_at;
ALTER TABLE barcode DROP COLUMN IF EXISTS external_product_id;
ALTER TABLE barcode DROP COLUMN IF EXISTS source;

COMMIT;
