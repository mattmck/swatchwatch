-- Up Migration

-- 20261023160917683_bottle-eval-samples.sql
-- Admin bottle-eval capture (Slice 0 of bottle recognition): the owner labels a
-- nail-polish bottle and photographs it as an evaluation sample. See
-- docs/superpowers/specs/2026-10-23-bottle-recognition-design.md §8.1 and
-- docs/superpowers/plans/2026-10-23-bottle-eval-capture.md.
--
-- * bottle_eval_sample — one labelled bottle: a catalog shade, or typed brand +
--                        shade text when it is not in the catalog (CHECK below).
-- * bottle_eval_frame  — the sample's photos in shooting order. Frames are private
--                        image_asset rows in USER_MEDIA_CONTAINER under
--                        {userId}/bottle-eval/ and are never read by the live
--                        resolver. The FK on image_id is deliberate: the
--                        orphan-media sweep discovers references from
--                        pg_constraint, so it never deletes eval frames.

BEGIN;

CREATE TABLE IF NOT EXISTS bottle_eval_sample (
  sample_id          BIGSERIAL PRIMARY KEY,
  shade_id           BIGINT REFERENCES shade(shade_id) ON DELETE SET NULL,  -- NULL = not in catalog
  brand_text         TEXT,                     -- typed when not in catalog (and kept as a snapshot otherwise)
  shade_text         TEXT,
  notes              TEXT,
  created_by_user_id BIGINT NOT NULL REFERENCES app_user(user_id) ON DELETE CASCADE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT bottle_eval_sample_label CHECK (shade_id IS NOT NULL OR (brand_text IS NOT NULL AND shade_text IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS bottle_eval_frame (
  frame_id     BIGSERIAL PRIMARY KEY,
  sample_id    BIGINT NOT NULL REFERENCES bottle_eval_sample(sample_id) ON DELETE CASCADE,
  image_id     BIGINT NOT NULL UNIQUE REFERENCES image_asset(image_id) ON DELETE CASCADE,
  surface      TEXT NOT NULL CHECK (surface IN ('front','bottom','glass','box')),
  frame_type   TEXT NOT NULL CHECK (frame_type IN ('barcode','label','color','other')),
  position     SMALLINT NOT NULL,              -- shooting order within the sample
  content_type TEXT NOT NULL,
  width        INTEGER, height INTEGER, size_bytes INTEGER,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bottle_eval_frame_sample ON bottle_eval_frame (sample_id, position);
CREATE INDEX IF NOT EXISTS idx_bottle_eval_sample_created ON bottle_eval_sample (created_at DESC, sample_id DESC);

COMMIT;

-- Down Migration

BEGIN;

DROP TABLE IF EXISTS bottle_eval_frame;
DROP TABLE IF EXISTS bottle_eval_sample;

COMMIT;
