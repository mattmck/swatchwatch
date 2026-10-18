-- Up Migration

-- 20261017061700000_shade-color-family-trim.sql
-- Color family filter (#103) follow-up: trim hexes and finishes like JavaScript trim().
--
-- 20261017061637910_add-shade-color-family trims with btrim() (via hex_to_oklab() for the
-- hex, and directly for the multichrome finish check), which strips only spaces. The TS
-- classifier in packages/shared/src/color/color-family.ts uses String.prototype.trim(),
-- which also strips tabs, newlines, NBSP, the BOM, etc., so a padded hex such as
-- E'\t#FF0000\n' or a finish such as E'\tMultichrome\u00a0' got a family in TS but NULL
-- in shade.color_family.
--
-- * shade_color_family_trim(value) — JS-trim() equivalent (explicit ECMAScript whitespace set).
-- * shade_color_family_from_hex() / shade_color_family() — same bodies as
--   20261017061637910 except the two trim call sites now use shade_color_family_trim().
--   hex_to_oklab() (and hex_agreement) is unchanged.
-- * shade.color_family — CREATE OR REPLACE does not recompute stored generated columns,
--   so only the rows whose family changes are rewritten. `SET finish = finish` (the recipe
--   in 20261017061637910) is what triggers the recompute: Postgres re-evaluates a stored
--   generated column only when a column it references is in the SET list, so
--   `SET color_family = DEFAULT` would keep the stale value. The column, its expression
--   and idx_shade_color_family are untouched, and shade has no triggers. The Down section
--   restores the btrim() bodies and recomputes the same way.

BEGIN;

-- JavaScript String.prototype.trim(): strips the ECMAScript whitespace and line terminators
-- (TAB, LF, VT, FF, CR, the Zs space separators, U+2028/U+2029 and the BOM U+FEFF) from both
-- ends, so the bins see the same string as classifyHexColorFamily() / hasMultichromeFinish()
-- in TS. btrim() strips only spaces, and [[:space:]] is locale-dependent (under C.UTF-8 it
-- misses U+00A0, U+2007, U+202F and U+FEFF); color-family.unit.test.cjs checks this class
-- against JS trim() on every BMP code point.
CREATE OR REPLACE FUNCTION shade_color_family_trim(value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT regexp_replace(
    value,
    '^[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+|[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$',
    '',
    'g'
  )
$$;

-- OKLCH bins for one hex. NULL when the hex is not a valid #RRGGBB.
CREATE OR REPLACE FUNCTION shade_color_family_from_hex(hex text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  neutral_max_chroma         CONSTANT double precision := 0.03;
  black_max_lightness        CONSTANT double precision := 0.3;
  dark_black_max_lightness   CONSTANT double precision := 0.2;
  dark_black_max_chroma      CONSTANT double precision := 0.06;
  white_min_lightness        CONSTANT double precision := 0.92;
  pale_white_min_lightness   CONSTANT double precision := 0.96;
  pale_white_max_chroma      CONSTANT double precision := 0.06;
  nude_min_hue               CONSTANT double precision := 20;
  nude_max_hue               CONSTANT double precision := 100;
  nude_min_lightness         CONSTANT double precision := 0.7;
  nude_max_chroma            CONSTANT double precision := 0.1;
  brown_min_hue              CONSTANT double precision := 30;
  brown_max_hue              CONSTANT double precision := 100;
  brown_max_lightness        CONSTANT double precision := 0.7;
  brown_max_chroma           CONSTANT double precision := 0.13;
  brown_dark_min_hue         CONSTANT double precision := 36;
  brown_dark_max_lightness   CONSTANT double precision := 0.45;
  pink_min_hue               CONSTANT double precision := 340;
  dark_pink_max_lightness    CONSTANT double precision := 0.5;
  berry_split_hue            CONSTANT double precision := 350;
  red_min_hue                CONSTANT double precision := 20;
  coral_min_lightness        CONSTANT double precision := 0.68;
  red_orange_split_hue       CONSTANT double precision := 36;
  orange_min_hue             CONSTANT double precision := 45;
  yellow_min_hue             CONSTANT double precision := 80;
  olive_max_lightness        CONSTANT double precision := 0.62;
  olive_split_hue            CONSTANT double precision := 100;
  green_min_hue              CONSTANT double precision := 115;
  teal_min_hue               CONSTANT double precision := 170;
  blue_min_hue               CONSTANT double precision := 205;
  purple_min_hue             CONSTANT double precision := 290;
  magenta_min_hue            CONSTANT double precision := 320;
  magenta_pink_min_lightness CONSTANT double precision := 0.6;
  magenta_pink_min_chroma    CONSTANT double precision := 0.1;
  lab double precision[];
  l double precision;
  c double precision;
  h double precision;
BEGIN
  lab := hex_to_oklab(shade_color_family_trim(hex));
  IF lab IS NULL THEN
    RETURN NULL;
  END IF;

  l := lab[1];
  c := sqrt(lab[2] * lab[2] + lab[3] * lab[3]);
  h := atan2(lab[3], lab[2]) * 180.0 / pi();
  IF h < 0 THEN
    h := h + 360;
  END IF;

  -- Achromatic / near-achromatic.
  IF c < neutral_max_chroma THEN
    IF l < black_max_lightness THEN RETURN 'black'; END IF;
    IF l >= white_min_lightness THEN RETURN 'white'; END IF;
    RETURN 'grey';
  END IF;
  IF l < dark_black_max_lightness AND c < dark_black_max_chroma THEN RETURN 'black'; END IF;
  IF l >= pale_white_min_lightness AND c < pale_white_max_chroma THEN RETURN 'white'; END IF;

  -- Low-chroma warm colors: nude (light) and brown (dark).
  IF h >= nude_min_hue AND h < nude_max_hue AND l >= nude_min_lightness AND c <= nude_max_chroma THEN
    RETURN 'nude';
  END IF;
  IF h >= brown_min_hue AND h < brown_max_hue AND l < brown_max_lightness
     AND (c <= brown_max_chroma OR (h >= brown_dark_min_hue AND l < brown_dark_max_lightness)) THEN
    RETURN 'brown';
  END IF;

  -- Hue bands.
  IF h >= pink_min_hue OR h < red_min_hue THEN
    IF l < dark_pink_max_lightness THEN
      IF h >= pink_min_hue AND h < berry_split_hue THEN RETURN 'purple'; END IF;
      RETURN 'red';
    END IF;
    RETURN 'pink';
  END IF;
  IF h < orange_min_hue THEN
    IF l >= coral_min_lightness THEN RETURN 'coral'; END IF;
    IF h < red_orange_split_hue THEN RETURN 'red'; END IF;
    RETURN 'orange';
  END IF;
  IF h < yellow_min_hue THEN RETURN 'orange'; END IF;
  IF h < green_min_hue THEN
    IF l < olive_max_lightness THEN
      IF h < olive_split_hue THEN RETURN 'brown'; END IF;
      RETURN 'green';
    END IF;
    RETURN 'yellow';
  END IF;
  IF h < teal_min_hue THEN RETURN 'green'; END IF;
  IF h < blue_min_hue THEN RETURN 'teal'; END IF;
  IF h < purple_min_hue THEN RETURN 'blue'; END IF;
  IF h < magenta_min_hue THEN RETURN 'purple'; END IF;
  IF l >= magenta_pink_min_lightness AND c >= magenta_pink_min_chroma THEN RETURN 'pink'; END IF;
  RETURN 'purple';
END;
$$;

-- Family of a shade: 'multichrome' for color-shifting finishes (any of finishes[] or the
-- legacy finish), otherwise the family of the display hex (vendor > detected > name).
CREATE OR REPLACE FUNCTION shade_color_family(
  p_vendor_hex text,
  p_detected_hex text,
  p_name_hex text,
  p_finishes text[],
  p_finish text
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM unnest(array_append(COALESCE(p_finishes, ARRAY[]::text[]), p_finish)) AS f(value)
    WHERE lower(shade_color_family_trim(f.value)) = ANY (ARRAY['multichrome', 'chameleon', 'colorshift', 'color shift', 'color-shift'])
  ) THEN
    RETURN 'multichrome';
  END IF;
  RETURN shade_color_family_from_hex(
    COALESCE(NULLIF(p_vendor_hex, ''), NULLIF(p_detected_hex, ''), NULLIF(p_name_hex, ''))
  );
END;
$$;

UPDATE shade
SET finish = finish
WHERE color_family IS DISTINCT FROM shade_color_family(vendor_hex, detected_hex, name_hex, finishes, finish);

COMMIT;

-- Down Migration

BEGIN;

-- OKLCH bins for one hex. NULL when the hex is not a valid #RRGGBB.
CREATE OR REPLACE FUNCTION shade_color_family_from_hex(hex text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  neutral_max_chroma         CONSTANT double precision := 0.03;
  black_max_lightness        CONSTANT double precision := 0.3;
  dark_black_max_lightness   CONSTANT double precision := 0.2;
  dark_black_max_chroma      CONSTANT double precision := 0.06;
  white_min_lightness        CONSTANT double precision := 0.92;
  pale_white_min_lightness   CONSTANT double precision := 0.96;
  pale_white_max_chroma      CONSTANT double precision := 0.06;
  nude_min_hue               CONSTANT double precision := 20;
  nude_max_hue               CONSTANT double precision := 100;
  nude_min_lightness         CONSTANT double precision := 0.7;
  nude_max_chroma            CONSTANT double precision := 0.1;
  brown_min_hue              CONSTANT double precision := 30;
  brown_max_hue              CONSTANT double precision := 100;
  brown_max_lightness        CONSTANT double precision := 0.7;
  brown_max_chroma           CONSTANT double precision := 0.13;
  brown_dark_min_hue         CONSTANT double precision := 36;
  brown_dark_max_lightness   CONSTANT double precision := 0.45;
  pink_min_hue               CONSTANT double precision := 340;
  dark_pink_max_lightness    CONSTANT double precision := 0.5;
  berry_split_hue            CONSTANT double precision := 350;
  red_min_hue                CONSTANT double precision := 20;
  coral_min_lightness        CONSTANT double precision := 0.68;
  red_orange_split_hue       CONSTANT double precision := 36;
  orange_min_hue             CONSTANT double precision := 45;
  yellow_min_hue             CONSTANT double precision := 80;
  olive_max_lightness        CONSTANT double precision := 0.62;
  olive_split_hue            CONSTANT double precision := 100;
  green_min_hue              CONSTANT double precision := 115;
  teal_min_hue               CONSTANT double precision := 170;
  blue_min_hue               CONSTANT double precision := 205;
  purple_min_hue             CONSTANT double precision := 290;
  magenta_min_hue            CONSTANT double precision := 320;
  magenta_pink_min_lightness CONSTANT double precision := 0.6;
  magenta_pink_min_chroma    CONSTANT double precision := 0.1;
  lab double precision[];
  l double precision;
  c double precision;
  h double precision;
BEGIN
  lab := hex_to_oklab(hex);
  IF lab IS NULL THEN
    RETURN NULL;
  END IF;

  l := lab[1];
  c := sqrt(lab[2] * lab[2] + lab[3] * lab[3]);
  h := atan2(lab[3], lab[2]) * 180.0 / pi();
  IF h < 0 THEN
    h := h + 360;
  END IF;

  -- Achromatic / near-achromatic.
  IF c < neutral_max_chroma THEN
    IF l < black_max_lightness THEN RETURN 'black'; END IF;
    IF l >= white_min_lightness THEN RETURN 'white'; END IF;
    RETURN 'grey';
  END IF;
  IF l < dark_black_max_lightness AND c < dark_black_max_chroma THEN RETURN 'black'; END IF;
  IF l >= pale_white_min_lightness AND c < pale_white_max_chroma THEN RETURN 'white'; END IF;

  -- Low-chroma warm colors: nude (light) and brown (dark).
  IF h >= nude_min_hue AND h < nude_max_hue AND l >= nude_min_lightness AND c <= nude_max_chroma THEN
    RETURN 'nude';
  END IF;
  IF h >= brown_min_hue AND h < brown_max_hue AND l < brown_max_lightness
     AND (c <= brown_max_chroma OR (h >= brown_dark_min_hue AND l < brown_dark_max_lightness)) THEN
    RETURN 'brown';
  END IF;

  -- Hue bands.
  IF h >= pink_min_hue OR h < red_min_hue THEN
    IF l < dark_pink_max_lightness THEN
      IF h >= pink_min_hue AND h < berry_split_hue THEN RETURN 'purple'; END IF;
      RETURN 'red';
    END IF;
    RETURN 'pink';
  END IF;
  IF h < orange_min_hue THEN
    IF l >= coral_min_lightness THEN RETURN 'coral'; END IF;
    IF h < red_orange_split_hue THEN RETURN 'red'; END IF;
    RETURN 'orange';
  END IF;
  IF h < yellow_min_hue THEN RETURN 'orange'; END IF;
  IF h < green_min_hue THEN
    IF l < olive_max_lightness THEN
      IF h < olive_split_hue THEN RETURN 'brown'; END IF;
      RETURN 'green';
    END IF;
    RETURN 'yellow';
  END IF;
  IF h < teal_min_hue THEN RETURN 'green'; END IF;
  IF h < blue_min_hue THEN RETURN 'teal'; END IF;
  IF h < purple_min_hue THEN RETURN 'blue'; END IF;
  IF h < magenta_min_hue THEN RETURN 'purple'; END IF;
  IF l >= magenta_pink_min_lightness AND c >= magenta_pink_min_chroma THEN RETURN 'pink'; END IF;
  RETURN 'purple';
END;
$$;

-- Family of a shade: 'multichrome' for color-shifting finishes (any of finishes[] or the
-- legacy finish), otherwise the family of the display hex (vendor > detected > name).
CREATE OR REPLACE FUNCTION shade_color_family(
  p_vendor_hex text,
  p_detected_hex text,
  p_name_hex text,
  p_finishes text[],
  p_finish text
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM unnest(array_append(COALESCE(p_finishes, ARRAY[]::text[]), p_finish)) AS f(value)
    WHERE lower(btrim(f.value)) = ANY (ARRAY['multichrome', 'chameleon', 'colorshift', 'color shift', 'color-shift'])
  ) THEN
    RETURN 'multichrome';
  END IF;
  RETURN shade_color_family_from_hex(
    COALESCE(NULLIF(p_vendor_hex, ''), NULLIF(p_detected_hex, ''), NULLIF(p_name_hex, ''))
  );
END;
$$;

UPDATE shade
SET finish = finish
WHERE color_family IS DISTINCT FROM shade_color_family(vendor_hex, detected_hex, name_hex, finishes, finish);

DROP FUNCTION IF EXISTS shade_color_family_trim(text);

COMMIT;
