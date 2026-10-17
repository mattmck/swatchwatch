-- Up Migration

-- Remembers which connector image URL each stored source image was downloaded from, so
-- ingestion reruns can reuse the stored image instead of downloading it again. Shopify CDN
-- URLs carry a `?v=` version that changes when an image is replaced, so an unchanged URL
-- means an unchanged image. Several URLs may map to one image_asset (same checksum).

BEGIN;

CREATE TABLE IF NOT EXISTS source_image_url (
  data_source_id BIGINT NOT NULL REFERENCES data_source(data_source_id) ON DELETE CASCADE,
  source_url TEXT NOT NULL,
  image_id BIGINT NOT NULL REFERENCES image_asset(image_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (data_source_id, source_url)
);

CREATE INDEX IF NOT EXISTS idx_source_image_url_image ON source_image_url(image_id);

COMMIT;

-- Down Migration

BEGIN;

DROP TABLE IF EXISTS source_image_url;

COMMIT;
