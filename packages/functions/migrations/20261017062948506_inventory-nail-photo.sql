-- Up Migration

-- 20261017062948506_inventory-nail-photo.sql
-- Private on-nail photo per inventory item (#270, docs/schema.sql "User Inventory").
--
-- One photo per user_inventory_item. The bytes live in the private user-media blob
-- container (USER_MEDIA_CONTAINER, default `nail-photos`), re-encoded server-side with
-- all EXIF/XMP/IPTC metadata (including GPS) removed. The blob is referenced through an
-- ordinary image_asset row (owner_type = 'user', owner_id = the uploader), so it is only
-- ever served through owner-scoped v3 image proxy ids (#227).
--
-- Ownership is the inventory item's user_id (like inventory_event, this child table carries
-- no user_id of its own, so an admin account merge that moves inventory moves the photo too).
-- Every API query joins user_inventory_item and filters ui.user_id = <caller> (#47).
--
-- * inventory_item_id — PK: at most one nail photo per inventory item. ON DELETE CASCADE drops
--                       the link when the item goes; the API deletes the image_asset row and
--                       the blob itself before deleting an item (DELETE /api/polishes/{id}).
-- * image_id          — UNIQUE: an image_asset backs at most one photo. ON DELETE CASCADE so
--                       deleting the asset (photo delete/replace) removes the link with it.

BEGIN;

CREATE TABLE IF NOT EXISTS inventory_nail_photo (
  inventory_item_id BIGINT PRIMARY KEY
    REFERENCES user_inventory_item(inventory_item_id) ON DELETE CASCADE,
  image_id BIGINT NOT NULL UNIQUE
    REFERENCES image_asset(image_id) ON DELETE CASCADE,
  content_type TEXT NOT NULL,
  width INT CHECK (width IS NULL OR width > 0),
  height INT CHECK (height IS NULL OR height > 0),
  size_bytes INT CHECK (size_bytes IS NULL OR size_bytes > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;

-- Down Migration

BEGIN;

-- Dropping the link leaves the image_asset rows and blobs in place (they are user-owned
-- media that is simply no longer attached to an inventory item).
DROP TABLE IF EXISTS inventory_nail_photo;

COMMIT;
