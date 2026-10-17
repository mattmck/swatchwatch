-- Up Migration

-- 20261017033500000_add-color-training-sample.sql
-- (Originally 025_add_color_training_sample.sql, briefly 20261016040629000_...; renamed because dev has a
-- 025_ migration and dated migrations that sort after it. Every statement is IF NOT
-- EXISTS, so a DB that ran it under the old name re-runs it harmlessly once
-- scripts/forget-renamed-migrations.cjs has dropped the old pgmigrations row.)
-- Ground-truth samples for vendor-image hex detection (docs/schema.sql
-- "Training Data Collection"). Written by the hex-detection evaluation
-- harness (`npm run eval:hex:populate --workspace=swatchwatch-functions`)
-- from shades whose vendor hex is present and not a known placeholder, then
-- exported to the JSON fixture format consumed by `npm run eval:hex`.
--
-- One row per (external_product, source_type) so re-running populate is
-- idempotent and refreshes the hex/image columns instead of duplicating rows.

BEGIN;

CREATE TABLE IF NOT EXISTS color_training_sample (
  training_sample_id BIGSERIAL PRIMARY KEY,
  data_source_id BIGINT REFERENCES data_source(data_source_id) ON DELETE SET NULL,
  external_product_id BIGINT REFERENCES external_product(external_product_id) ON DELETE SET NULL,

  -- Image data - can have multiple images per sample
  image_urls JSONB NOT NULL DEFAULT '[]',     -- array of {url, storage_path, is_primary}

  -- Ground truth labels (from vendor data)
  hex TEXT NOT NULL,                          -- ground truth hex from variant options
  color_name TEXT,                            -- original color name from vendor
  variant_option TEXT,                        -- which option contained the hex

  -- Product context
  brand_name TEXT,
  product_name TEXT,
  product_handle TEXT,

  -- Processing metadata
  source_type TEXT NOT NULL DEFAULT 'vendor_option',  -- vendor_option|ai_detected|manual|swatch
  training_status TEXT NOT NULL DEFAULT 'pending',    -- pending|approved|rejected|used
  confidence NUMERIC(4,3),                    -- confidence in the hex accuracy
  notes TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_color_training_hex ON color_training_sample(hex);
CREATE INDEX IF NOT EXISTS idx_color_training_brand ON color_training_sample(brand_name);
CREATE INDEX IF NOT EXISTS idx_color_training_status ON color_training_sample(training_status);
CREATE INDEX IF NOT EXISTS idx_color_training_source_type ON color_training_sample(source_type);
CREATE INDEX IF NOT EXISTS idx_color_training_created ON color_training_sample(created_at DESC);

-- Idempotent populate: one sample per external product and source type.
CREATE UNIQUE INDEX IF NOT EXISTS idx_color_training_external_product_source
  ON color_training_sample(external_product_id, source_type)
  WHERE external_product_id IS NOT NULL;

COMMIT;

-- Down Migration

BEGIN;

DROP TABLE IF EXISTS color_training_sample;

COMMIT;
