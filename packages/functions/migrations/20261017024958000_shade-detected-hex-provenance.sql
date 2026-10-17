-- Up Migration

-- 20261017024958000_shade-detected-hex-provenance.sql
-- Record where every shade.detected_hex came from and how well it agrees
-- with the vendor hex.
--
-- * detected_hex_confidence   — model self-reported confidence (0..1) for detected_hex
-- * detected_hex_method       — detection strategy: 'vision-direct' today; later
--                               'palette-pick', 'region-crop', 'ensemble', …
--                               ('client-supplied' when a user API request backfilled it)
-- * detected_hex_model        — Azure OpenAI deployment name that answered
-- * detected_hex_prompt_version — prompt revision (PROMPT_VERSION in
--                               packages/functions/src/lib/ai-color-detection.ts)
-- * detected_hex_at           — when detected_hex was last written
-- * hex_agreement             — OKLAB distance between vendor_hex and detected_hex
--                               (NULL unless both are valid #RRGGBB values). It is a
--                               STORED GENERATED column so every write path (ingestion
--                               sync/batch, recalc-hex, user backfills) keeps it current
--                               and existing rows are backfilled here. The math mirrors
--                               packages/shared/src/color/oklab.ts (colorDistance):
--                               black↔white ≈ 1.0, ~0.02 is a just-noticeable difference,
--                               > 0.10 (MEDIUM) is a flagged disagreement.

BEGIN;

-- sRGB #RRGGBB → OKLAB {L, a, b}. NULL for anything that is not a 6-digit hex.
CREATE OR REPLACE FUNCTION hex_to_oklab(hex text)
RETURNS double precision[]
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  clean text;
  r double precision;
  g double precision;
  b double precision;
  l_ double precision;
  m_ double precision;
  s_ double precision;
BEGIN
  IF hex IS NULL THEN
    RETURN NULL;
  END IF;
  clean := upper(regexp_replace(btrim(hex), '^#', ''));
  IF clean !~ '^[0-9A-F]{6}$' THEN
    RETURN NULL;
  END IF;

  r := ('x' || substr(clean, 1, 2))::bit(8)::int / 255.0;
  g := ('x' || substr(clean, 3, 2))::bit(8)::int / 255.0;
  b := ('x' || substr(clean, 5, 2))::bit(8)::int / 255.0;

  -- linearize sRGB
  r := CASE WHEN r <= 0.04045 THEN r / 12.92 ELSE power((r + 0.055) / 1.055, 2.4) END;
  g := CASE WHEN g <= 0.04045 THEN g / 12.92 ELSE power((g + 0.055) / 1.055, 2.4) END;
  b := CASE WHEN b <= 0.04045 THEN b / 12.92 ELSE power((b + 0.055) / 1.055, 2.4) END;

  l_ := cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  m_ := cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  s_ := cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

  RETURN ARRAY[
    0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_
  ];
END;
$$;

-- Euclidean OKLAB distance between two hex colors, rounded to 4 decimals.
-- NULL when either side is missing/invalid.
CREATE OR REPLACE FUNCTION hex_oklab_distance(hex_a text, hex_b text)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  a double precision[];
  b double precision[];
BEGIN
  a := hex_to_oklab(hex_a);
  b := hex_to_oklab(hex_b);
  IF a IS NULL OR b IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN round(
    sqrt(power(a[1] - b[1], 2) + power(a[2] - b[2], 2) + power(a[3] - b[3], 2))::numeric,
    4
  );
END;
$$;

ALTER TABLE shade
  ADD COLUMN IF NOT EXISTS detected_hex_confidence NUMERIC(4,3),
  ADD COLUMN IF NOT EXISTS detected_hex_method TEXT,
  ADD COLUMN IF NOT EXISTS detected_hex_model TEXT,
  ADD COLUMN IF NOT EXISTS detected_hex_prompt_version TEXT,
  ADD COLUMN IF NOT EXISTS detected_hex_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS hex_agreement NUMERIC(6,4)
    GENERATED ALWAYS AS (hex_oklab_distance(vendor_hex, detected_hex)) STORED;

ALTER TABLE shade
  ADD CONSTRAINT chk_shade_detected_hex_confidence
    CHECK (detected_hex_confidence IS NULL OR (detected_hex_confidence >= 0 AND detected_hex_confidence <= 1));

-- Review queue: worst agreement / lowest confidence among detected shades.
CREATE INDEX IF NOT EXISTS idx_shade_hex_agreement
  ON shade (hex_agreement DESC NULLS LAST)
  WHERE detected_hex IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_shade_detected_hex_confidence
  ON shade (detected_hex_confidence ASC NULLS LAST)
  WHERE detected_hex IS NOT NULL;

COMMIT;

-- Down Migration

BEGIN;

DROP INDEX IF EXISTS idx_shade_detected_hex_confidence;
DROP INDEX IF EXISTS idx_shade_hex_agreement;

ALTER TABLE shade
  DROP CONSTRAINT IF EXISTS chk_shade_detected_hex_confidence;

ALTER TABLE shade
  DROP COLUMN IF EXISTS hex_agreement,
  DROP COLUMN IF EXISTS detected_hex_at,
  DROP COLUMN IF EXISTS detected_hex_prompt_version,
  DROP COLUMN IF EXISTS detected_hex_model,
  DROP COLUMN IF EXISTS detected_hex_method,
  DROP COLUMN IF EXISTS detected_hex_confidence;

DROP FUNCTION IF EXISTS hex_oklab_distance(text, text);
DROP FUNCTION IF EXISTS hex_to_oklab(text);

COMMIT;
