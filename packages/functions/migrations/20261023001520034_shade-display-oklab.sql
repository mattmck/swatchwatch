-- Up Migration

-- 20261023001520034_shade-display-oklab.sql
-- Server-side color-distance sort (`?nearHex=` on GET /api/polishes): the OKLAB coordinates of
-- each shade's display hex, stored so ranking a family or the whole catalog by distance is
-- plain arithmetic per row instead of a plpgsql hex_to_oklab() call per row.
--
-- * shade.oklab_l / oklab_a / oklab_b — STORED GENERATED from the display hex
--   (vendor > detected > name, i.e. resolveDisplayHex), trimmed and validated exactly like
--   shade.color_family (shade_color_family_trim + hex_to_oklab from migration
--   20261017024958000_shade-detected-hex-provenance). NULL when the shade has no usable hex,
--   so those shades sort last. Every write path keeps them current without code changes.
--
-- The API computes the target's OKLAB with hexToOklab() from packages/shared and the distance
-- in SQL; packages/functions/tests/near-hex.unit.test.cjs keeps hex_to_oklab() equal to the TS
-- conversion. Measured on 60k synthetic shades: ranking by the stored columns took ~9 ms vs
-- ~73 ms calling hex_to_oklab() per row at query time.
-- See the "Catalog" section of docs/schema.sql.

BEGIN;

ALTER TABLE shade
  ADD COLUMN IF NOT EXISTS oklab_l DOUBLE PRECISION GENERATED ALWAYS AS (
    (hex_to_oklab(shade_color_family_trim(COALESCE(NULLIF(vendor_hex, ''), NULLIF(detected_hex, ''), NULLIF(name_hex, '')))))[1]
  ) STORED,
  ADD COLUMN IF NOT EXISTS oklab_a DOUBLE PRECISION GENERATED ALWAYS AS (
    (hex_to_oklab(shade_color_family_trim(COALESCE(NULLIF(vendor_hex, ''), NULLIF(detected_hex, ''), NULLIF(name_hex, '')))))[2]
  ) STORED,
  ADD COLUMN IF NOT EXISTS oklab_b DOUBLE PRECISION GENERATED ALWAYS AS (
    (hex_to_oklab(shade_color_family_trim(COALESCE(NULLIF(vendor_hex, ''), NULLIF(detected_hex, ''), NULLIF(name_hex, '')))))[3]
  ) STORED;

COMMIT;

-- Down Migration

BEGIN;

ALTER TABLE shade
  DROP COLUMN IF EXISTS oklab_b,
  DROP COLUMN IF EXISTS oklab_a,
  DROP COLUMN IF EXISTS oklab_l;

COMMIT;
