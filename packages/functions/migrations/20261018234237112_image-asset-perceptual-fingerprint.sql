-- Up Migration

-- 20261018234237112_image-asset-perceptual-fingerprint.sql
-- Persist a perceptual fingerprint per image so catalog gallery near-duplicates can be found
-- without re-reading blobs (computeImageFingerprint in src/lib/gallery-dedupe.ts).
--
-- * image_asset.perceptual_hash    — 256-bit gradient hash (dHash, 16×16) as 64 hex chars.
-- * image_asset.thumb_fingerprint  — 16×16 RGB thumbnail (768 bytes), compared by mean
--                                    absolute difference.
-- * image_asset.image_width/height — displayed pixel size (EXIF orientation applied), for the
--                                    aspect-ratio check.
--
-- All four are filled together (CHECK) and are NULL for rows stored before this migration or
-- whose bytes could not be decoded. Ingestion fills them on upload (uploadSourceImageToBlob);
-- images reused by connector URL without a download are backfilled by
-- POST /api/images-admin/gallery-dedupe (`backfillFingerprints`). Derived data only: dropping
-- the columns loses nothing that cannot be recomputed from the blobs.
--
-- See the image_asset section of docs/schema.sql.

BEGIN;

ALTER TABLE image_asset
  ADD COLUMN IF NOT EXISTS perceptual_hash TEXT,
  ADD COLUMN IF NOT EXISTS thumb_fingerprint BYTEA,
  ADD COLUMN IF NOT EXISTS image_width INTEGER,
  ADD COLUMN IF NOT EXISTS image_height INTEGER;

ALTER TABLE image_asset DROP CONSTRAINT IF EXISTS image_asset_fingerprint_complete;
ALTER TABLE image_asset
  ADD CONSTRAINT image_asset_fingerprint_complete CHECK (
    num_nulls(perceptual_hash, thumb_fingerprint, image_width, image_height) = 4
    OR (
      num_nonnulls(perceptual_hash, thumb_fingerprint, image_width, image_height) = 4
      AND perceptual_hash ~ '^[0-9a-f]{64}$'
      AND octet_length(thumb_fingerprint) = 768
      AND image_width > 0
      AND image_height > 0
    )
  ) NOT VALID;

COMMIT;

-- Validated after COMMIT: VALIDATE CONSTRAINT takes only a SHARE UPDATE EXCLUSIVE lock, so image
-- reads and writes continue while it scans image_asset (the new columns are all NULL, so it passes).
-- Adding the CHECK without NOT VALID would scan under the ACCESS EXCLUSIVE lock of ADD COLUMN.
ALTER TABLE image_asset VALIDATE CONSTRAINT image_asset_fingerprint_complete;

-- Down Migration

BEGIN;

ALTER TABLE image_asset DROP CONSTRAINT IF EXISTS image_asset_fingerprint_complete;
ALTER TABLE image_asset
  DROP COLUMN IF EXISTS image_height,
  DROP COLUMN IF EXISTS image_width,
  DROP COLUMN IF EXISTS thumb_fingerprint,
  DROP COLUMN IF EXISTS perceptual_hash;

COMMIT;
