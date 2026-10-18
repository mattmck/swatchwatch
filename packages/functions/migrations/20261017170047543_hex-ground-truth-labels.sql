-- Up Migration

-- 20261017170047543_hex-ground-truth-labels.sql
-- Hand-labelled ground-truth hexes from the admin Hex Labeling tool (admin console
-- tab "Hex Labeling", routes /api/hex-labels-admin*). An admin samples the polish
-- colour from one of the shade's product images with an eyedropper; the result is
-- stored as a `color_training_sample` row with source_type = 'manual' so
-- `npm run eval:hex:populate` exports it as a `manual` ground-truth case for
-- `npm run eval:hex` (docs/schema.sql "Training Data Collection").
--
-- * shade_id            — the labelled shade. One manual label per shade (partial
--                         unique index below); relabelling replaces it. SET NULL on
--                         shade delete so the image + hex pair survives for eval.
-- * image_id            — the image_asset the colour was sampled from (NULL when the
--                         admin typed the hex without sampling an image).
-- * labeled_by_user_id  — the admin who saved the label.
-- * label_meta          — how the hex was picked: {"method": "canvas"|"eyedropper"|"manual",
--                         "samplePoint": {"x", "y", "size", "imageWidth", "imageHeight"}}
--                         (x/y normalized 0..1 to the image's natural size).
-- * hex becomes nullable — only for rows marked training_status = 'rejected' (the
--                         admin flagged the images as unreliable and picked nothing).
--                         Every other row still needs a hex (CHECK below), so the eval
--                         exporter (pending/approved by default) never sees a NULL.
--
-- shade.vendor_hex / shade.detected_hex are never written by the labeler.

BEGIN;

ALTER TABLE color_training_sample
  ADD COLUMN IF NOT EXISTS shade_id BIGINT REFERENCES shade(shade_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS image_id BIGINT REFERENCES image_asset(image_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS labeled_by_user_id BIGINT REFERENCES app_user(user_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS label_meta JSONB;

ALTER TABLE color_training_sample ALTER COLUMN hex DROP NOT NULL;

ALTER TABLE color_training_sample DROP CONSTRAINT IF EXISTS color_training_sample_hex_required;
ALTER TABLE color_training_sample
  ADD CONSTRAINT color_training_sample_hex_required
  CHECK (hex IS NOT NULL OR training_status = 'rejected');

-- One manual label per shade: the labeler upserts on this index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_color_training_manual_shade
  ON color_training_sample(shade_id)
  WHERE source_type = 'manual' AND shade_id IS NOT NULL;

COMMIT;

-- Down Migration

BEGIN;

DROP INDEX IF EXISTS idx_color_training_manual_shade;

ALTER TABLE color_training_sample DROP CONSTRAINT IF EXISTS color_training_sample_hex_required;

-- Rows without a hex (manual "unreliable image" flags) cannot survive NOT NULL.
DELETE FROM color_training_sample WHERE hex IS NULL;
ALTER TABLE color_training_sample ALTER COLUMN hex SET NOT NULL;

ALTER TABLE color_training_sample
  DROP COLUMN IF EXISTS label_meta,
  DROP COLUMN IF EXISTS labeled_by_user_id,
  DROP COLUMN IF EXISTS image_id,
  DROP COLUMN IF EXISTS shade_id;

COMMIT;
