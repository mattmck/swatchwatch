-- Up Migration

-- 20261110120000000_enable-picture-painted-potion-polish-sources.sql
-- Enables three brand stores registered disabled and pending on 2026-11-08 (brand sources plan,
-- Tasks 16 and 17): PicturePolishWooCommerce (WooCommerce Store API), PaintedPolishBigCartel and
-- PotionPolishBigCartel (Big Cartel v0 API). Each now has a store filter and a shade-name parser
-- (src/lib/connectors/store-filters/picture-polish.ts, painted-polish.ts, potion-polish.ts).
--
-- Decision D27 (docs/decisions-2026-10.md): on 2026-11-10 the owner decided to enable these three
-- WITHOUT a store OK, after the terms were read that day. Nobody at the stores confirmed anything:
-- * Picture Polish's terms (https://picturepolish.com.au/terms-conditions/) exclude data mining
--   robots and extraction tools, require prior written permission to copy or republish site
--   information and do not permit linking; robots.txt does not disallow /wp-json/.
-- * Big Cartel's API License Agreement (dated 07.21.23) permits displaying a shop's public
--   listings in an application, but not content more than six hours older than the shop, requires
--   deleting content that is no longer public and forbids building a database from the content
--   beyond a cache; SwatchWatch keeps shades permanently, so the catalog does not meet those
--   terms. The two stores' own terms pages were not found.
-- metadata.notes records these facts and ends "Enabled on 2026-11-10 by the owner's decision
-- without a store OK; ask the maker for the record."
--
-- Only rows still pending are touched (an admin who already enabled or edited a row is left
-- alone), so every statement is idempotent. Each changed row is stamped
-- metadata.enabledByMigration and keeps the notes and verification it replaced in
-- metadata.preEnableMetadata, so Down restores exactly what Up changed.
-- Keep in sync with docs/seed_data_sources.sql. PotionPolishShopify (superseded, disabled) is not
-- touched.

BEGIN;

UPDATE data_source
SET enabled = true,
    metadata = (metadata - 'pendingApproval')
      || jsonb_build_object(
           'enabledByMigration', '20261110120000000',
           'preEnableMetadata', jsonb_build_object('notes', metadata->'notes', 'verification', metadata->'verification'),
           'verification',
           COALESCE(metadata->'verification', '{}'::jsonb)
             || '{"robotsTxt": "store-api-not-disallowed", "termsScrapingClause": true, "termsUrl": "https://picturepolish.com.au/terms-conditions/", "termsCheckedAt": "2026-11-10", "products": 143, "storeFilterPass": 116, "storeFilterCheckedAt": "2026-11-10"}'::jsonb
         )
      || '{"notes": "Picture Polish brand store (Australia, AUD), read through the WooCommerce Store API (WooCommerce connector, brand sources plan Task 16). Verified 2026-11-08: https://picturepolish.com.au/wp-json/wc/store/v1/products answered 200 with WooCommerce Store API products (143 products, all simple, on 2026-11-10). The store filter connectors/store-filters/picture-polish.ts keeps Nail Colours unless the product is also in Bundles, drops Bundles and leaves the rest to the generic gate: 116 of 143 kept, measured offline on 2026-11-10 (104 colour, 5 top coats, 3 base coats, 3 treatments, 1 accessory by name); its title parser takes the shade name from the first | segment (Camelot | Purple | Flakie gives Camelot). Terms: https://picturepolish.com.au/terms-conditions/ (read 2026-11-10): site access \"does not include the right to use any data mining robots or other extraction tools\"; copying or republishing site information needs prior written permission; \"Linking our website is not permitted\". robots.txt does not disallow /wp-json/. The connector checks robots.txt before any product request. Enabled on 2026-11-10 by the owner''s decision without a store OK; ask the maker for the record."}'::jsonb
WHERE name = 'PicturePolishWooCommerce'
  AND metadata->>'pendingApproval' = 'true';

UPDATE data_source
SET enabled = true,
    metadata = (metadata - 'pendingApproval')
      || jsonb_build_object(
           'enabledByMigration', '20261110120000000',
           'preEnableMetadata', jsonb_build_object('notes', metadata->'notes', 'verification', metadata->'verification'),
           'verification',
           COALESCE(metadata->'verification', '{}'::jsonb)
             || '{"storeFilterPass": 246, "storeFilterCheckedAt": "2026-11-10", "termsCheckedAt": "2026-11-10", "apiLicenseUrl": "https://www.bigcartel.com/resources/help/article/api-license-agreement", "apiLicenseDated": "2023-07-21", "apiLicenseStorageClause": true, "storeTermsFound": false}'::jsonb
         )
      || '{"notes": "Painted Polish brand store on Big Cartel, read through the Big Cartel v0 API (BigCartel connector, brand sources plan Task 17). Painted Polish''s own domain answered 404 for /products.json on 2026-11-08 and sits behind Cloudflare; the v0 API answers under the subdomain paintedpolish. Verified 2026-11-08: https://api.bigcartel.com/paintedpolish/products.json answered 200 with 287 products (135 active, 152 sold-out). The generic gate keeps 47 of its products (2026-11-08); the store filter connectors/store-filters/painted-polish.ts keeps Individual Shades, drops Sets and the Imperfect Label Bottles listing and leaves the rest to the generic gate: 246 of 287 kept, measured offline on 2026-11-10; its title parser drops one trailing parenthetical stock note that says FINAL (Pumpkin To Talk About (FINAL 3 BOTTLES) gives Pumpkin To Talk About). The store currency comes from the API''s store.json at ingest time. Terms: the Big Cartel API License Agreement (https://www.bigcartel.com/resources/help/article/api-license-agreement, dated 07.21.23, read 2026-11-10) governs this store: displaying a shop''s public listings in an application is a permitted use, but an application may not display content \"more than six hours older\" than the shop, must delete public content once it is no longer public, and may not \"create a database by downloading and storing the Content\" beyond a cache. SwatchWatch keeps shades permanently, so the catalog does not meet those terms. The store''s own terms page was not found (404 at /terms and /terms-and-conditions on 2026-11-10). Enabled on 2026-11-10 by the owner''s decision without a store OK; ask the maker for the record."}'::jsonb
WHERE name = 'PaintedPolishBigCartel'
  AND metadata->>'pendingApproval' = 'true';

UPDATE data_source
SET enabled = true,
    metadata = (metadata - 'pendingApproval')
      || jsonb_build_object(
           'enabledByMigration', '20261110120000000',
           'preEnableMetadata', jsonb_build_object('notes', metadata->'notes', 'verification', metadata->'verification'),
           'verification',
           COALESCE(metadata->'verification', '{}'::jsonb)
             || '{"storeFilterPass": 32, "storeFilterCheckedAt": "2026-11-10", "termsCheckedAt": "2026-11-10", "apiLicenseUrl": "https://www.bigcartel.com/resources/help/article/api-license-agreement", "apiLicenseDated": "2023-07-21", "apiLicenseStorageClause": true, "storeTermsFound": false}'::jsonb
         )
      || '{"notes": "Potion Polish brand store on Big Cartel, read through the Big Cartel v0 API (BigCartel connector, brand sources plan Task 17). Replaces the disabled PotionPolishShopify row (the store moved from Shopify to Big Cartel). Verified 2026-11-08: https://api.bigcartel.com/potionpolish/products.json answered 200 with 35 products (33 active, 2 sold-out). The generic gate keeps 0 of its products (2026-11-08: its categories are finish and collection names); the store filter connectors/store-filters/potion-polish.ts keeps every product except the Mystery Polish category: 32 of 35 kept, measured offline on 2026-11-10; its title parser drops trailing notes after a dash (Limited Edition, Magnetic, Last Chance For Now!, Back In Stock ...), so Autumn Enthusiast - Magnetic - Limited Edition gives Autumn Enthusiast. The store currency comes from the API''s store.json at ingest time. Terms: the Big Cartel API License Agreement (https://www.bigcartel.com/resources/help/article/api-license-agreement, dated 07.21.23, read 2026-11-10) governs this store: displaying a shop''s public listings in an application is a permitted use, but an application may not display content \"more than six hours older\" than the shop, must delete public content once it is no longer public, and may not \"create a database by downloading and storing the Content\" beyond a cache. SwatchWatch keeps shades permanently, so the catalog does not meet those terms. The store''s own terms page was not found (404 at /terms and /terms-and-conditions on 2026-11-10). Enabled on 2026-11-10 by the owner''s decision without a store OK; ask the maker for the record."}'::jsonb
WHERE name = 'PotionPolishBigCartel'
  AND metadata->>'pendingApproval' = 'true';

COMMIT;


-- Down Migration
-- Disable again, restore pendingApproval and the notes and verification Up replaced, and drop the
-- stamps, only on rows this migration's Up changed. Ingestion data already imported is untouched.
BEGIN;

UPDATE data_source
SET enabled = false,
    metadata = (metadata - 'enabledByMigration' - 'preEnableMetadata')
      || jsonb_build_object(
           'notes', metadata->'preEnableMetadata'->'notes',
           'verification', metadata->'preEnableMetadata'->'verification'
         )
      || '{"pendingApproval": true}'::jsonb
WHERE name IN ('PicturePolishWooCommerce', 'PaintedPolishBigCartel', 'PotionPolishBigCartel')
  AND metadata->>'enabledByMigration' = '20261110120000000';

COMMIT;
