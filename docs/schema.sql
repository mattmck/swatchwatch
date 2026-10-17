-- nail_polish_schema_v1_1.sql
-- Version: 1.1 (adds provenance + external source ingestion tables)
-- Full starter schema for Nail Polish Knowledge Graph
-- Requires: pg_trgm, pgvector

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS vector;

-- ── Color helpers (migration 20261017024958000_shade-detected-hex-provenance) ───────────────────────────────────────────
-- OKLAB math mirroring packages/shared/src/color/oklab.ts so shade.hex_agreement
-- (a generated column) agrees with colorDistance() in the web app and API.

-- sRGB #RRGGBB → OKLAB {L, a, b}. NULL for anything that is not a 6-digit hex.
CREATE OR REPLACE FUNCTION hex_to_oklab(hex text)
RETURNS double precision[]
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  clean text;
  r double precision; g double precision; b double precision;
  l_ double precision; m_ double precision; s_ double precision;
BEGIN
  IF hex IS NULL THEN RETURN NULL; END IF;
  clean := upper(regexp_replace(btrim(hex), '^#', ''));
  IF clean !~ '^[0-9A-F]{6}$' THEN RETURN NULL; END IF;
  r := ('x' || substr(clean, 1, 2))::bit(8)::int / 255.0;
  g := ('x' || substr(clean, 3, 2))::bit(8)::int / 255.0;
  b := ('x' || substr(clean, 5, 2))::bit(8)::int / 255.0;
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

-- Euclidean OKLAB distance between two hex colors, rounded to 4 decimals (NULL if either is invalid).
CREATE OR REPLACE FUNCTION hex_oklab_distance(hex_a text, hex_b text)
RETURNS numeric
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  a double precision[]; b double precision[];
BEGIN
  a := hex_to_oklab(hex_a);
  b := hex_to_oklab(hex_b);
  IF a IS NULL OR b IS NULL THEN RETURN NULL; END IF;
  RETURN round(sqrt(power(a[1] - b[1], 2) + power(a[2] - b[2], 2) + power(a[3] - b[3], 2))::numeric, 4);
END;
$$;

-- ── Color family (migrations 20261017061637910_add-shade-color-family and
--    20261017061700000_shade-color-family-trim, #103) ──────────────────────────────────
-- Mirrors classifyColorFamily() in packages/shared/src/color/color-family.ts (thresholds are
-- COLOR_FAMILY_THRESHOLDS in snake_case; packages/functions/tests/color-family.unit.test.cjs
-- keeps them in sync). Feeds the generated shade.color_family column.

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

-- Provenance
CREATE TABLE source (
  source_id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  license TEXT,
  terms_url TEXT
);

CREATE TABLE source_record (
  source_record_id BIGSERIAL PRIMARY KEY,
  source_id BIGINT NOT NULL REFERENCES source(source_id),
  record_type TEXT NOT NULL, -- 'shade'|'sku'|'label'|'image'|...
  external_id TEXT NOT NULL,
  raw_json JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_id, record_type, external_id)
);

-- Catalog
CREATE TABLE brand (
  brand_id BIGSERIAL PRIMARY KEY,
  name_canonical TEXT NOT NULL UNIQUE
);

CREATE TABLE brand_alias (
  brand_alias_id BIGSERIAL PRIMARY KEY,
  brand_id BIGINT NOT NULL REFERENCES brand(brand_id),
  alias TEXT NOT NULL,
  UNIQUE (brand_id, alias)
);

CREATE TABLE product_line (
  product_line_id BIGSERIAL PRIMARY KEY,
  brand_id BIGINT NOT NULL REFERENCES brand(brand_id),
  name_canonical TEXT NOT NULL,
  UNIQUE (brand_id, name_canonical)
);

CREATE TABLE shade (
  shade_id BIGSERIAL PRIMARY KEY,
  brand_id BIGINT NOT NULL REFERENCES brand(brand_id),
  product_line_id BIGINT REFERENCES product_line(product_line_id),
  shade_name_canonical TEXT NOT NULL,
  finish TEXT,                                   -- legacy single finish; part of the identity key below
  finishes TEXT[] NOT NULL DEFAULT ARRAY[]::text[], -- canonical multi-finish list, primary first (migration 023)
  detected_finishes TEXT[],                      -- AI-detected finishes (migration 016)
  collection TEXT,
  release_year INT,
  status TEXT NOT NULL DEFAULT 'unknown',       -- active|user_submitted|...; user_submitted = private to creator/inventory holders until an admin sets 'active' (migration 024)
  created_by_user_id BIGINT REFERENCES app_user(user_id) ON DELETE SET NULL, -- creator of a user-API shade; NULL for catalog/ingestion rows (migration 024)
  color_name TEXT,
  vendor_hex TEXT,                               -- hex published by the vendor (e.g. Shopify variant option)
  detected_hex TEXT,                             -- hex detected from the product image (AI vision)
  name_hex TEXT,                                 -- hex inferred from the color name
  -- detected_hex provenance (migration 20261017024958000_shade-detected-hex-provenance): who/what produced detected_hex and how sure it was
  detected_hex_confidence NUMERIC(4,3) CHECK (detected_hex_confidence IS NULL OR (detected_hex_confidence >= 0 AND detected_hex_confidence <= 1)),
  detected_hex_method TEXT,                      -- 'vision-direct' | 'palette-pick' | 'region-crop' | 'ensemble' | 'client-supplied' | …
  detected_hex_model TEXT,                       -- Azure OpenAI deployment name
  detected_hex_prompt_version TEXT,              -- PROMPT_VERSION in packages/functions/src/lib/ai-color-detection.ts
  detected_hex_at TIMESTAMPTZ,                   -- when detected_hex was last written
  -- OKLAB distance vendor_hex ↔ detected_hex (NULL unless both are valid); kept current by Postgres on every write
  hex_agreement NUMERIC(6,4) GENERATED ALWAYS AS (hex_oklab_distance(vendor_hex, detected_hex)) STORED,
  -- Color family of the display hex (vendor > detected > name), or 'multichrome' for color-shifting
  -- finishes; NULL without a usable hex. Filtered by ?family= (migration 20261017061637910_add-shade-color-family)
  color_family TEXT GENERATED ALWAYS AS (shade_color_family(vendor_hex, detected_hex, name_hex, finishes, finish)) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (brand_id, product_line_id, shade_name_canonical, COALESCE(finish,''))
);

CREATE INDEX idx_shade_finishes ON shade USING GIN (finishes);
CREATE INDEX idx_shade_created_by_user ON shade (created_by_user_id) WHERE created_by_user_id IS NOT NULL;
-- Hex review queue (admin GET /api/polishes-admin/hex-review): worst agreement / lowest confidence first
CREATE INDEX idx_shade_hex_agreement ON shade (hex_agreement DESC NULLS LAST) WHERE detected_hex IS NOT NULL;
CREATE INDEX idx_shade_detected_hex_confidence ON shade (detected_hex_confidence ASC NULLS LAST) WHERE detected_hex IS NOT NULL;
-- Color family filter (GET /api/polishes?family=, GET /api/catalog/search?family=)
CREATE INDEX idx_shade_color_family ON shade (color_family);

CREATE TABLE shade_alias (
  shade_alias_id BIGSERIAL PRIMARY KEY,
  shade_id BIGINT NOT NULL REFERENCES shade(shade_id),
  alias TEXT NOT NULL,
  UNIQUE (shade_id, alias)
);

CREATE TABLE sku (
  sku_id BIGSERIAL PRIMARY KEY,
  brand_id BIGINT NOT NULL REFERENCES brand(brand_id),
  product_line_id BIGINT REFERENCES product_line(product_line_id),
  shade_id BIGINT REFERENCES shade(shade_id),
  product_name TEXT,
  size_ml NUMERIC(6,2),
  country_market TEXT,
  is_set BOOLEAN NOT NULL DEFAULT FALSE,
  set_count INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE barcode (
  barcode_id BIGSERIAL PRIMARY KEY,
  sku_id BIGINT NOT NULL REFERENCES sku(sku_id) ON DELETE CASCADE,
  gtin TEXT NOT NULL UNIQUE,
  barcode_type TEXT,
  is_primary BOOLEAN NOT NULL DEFAULT TRUE
);

-- Labels (versioned)
CREATE TABLE label_document (
  label_id BIGSERIAL PRIMARY KEY,
  sku_id BIGINT NOT NULL REFERENCES sku(sku_id) ON DELETE CASCADE,
  source_record_id BIGINT REFERENCES source_record(source_record_id),
  inci_text_raw TEXT,
  language TEXT,
  country_market TEXT,
  effective_from DATE,
  effective_to DATE,
  extracted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ingredient (
  ingredient_id BIGSERIAL PRIMARY KEY,
  inci_name_canonical TEXT NOT NULL UNIQUE
);

CREATE TABLE label_ingredient (
  label_id BIGINT NOT NULL REFERENCES label_document(label_id) ON DELETE CASCADE,
  ingredient_id BIGINT NOT NULL REFERENCES ingredient(ingredient_id),
  position INT,
  confidence NUMERIC(4,3) NOT NULL DEFAULT 1.000,
  PRIMARY KEY (label_id, ingredient_id)
);

CREATE TABLE claim (
  claim_id BIGSERIAL PRIMARY KEY,
  claim_type TEXT NOT NULL,
  claim_text_raw TEXT
);

CREATE TABLE label_claim (
  label_id BIGINT NOT NULL REFERENCES label_document(label_id) ON DELETE CASCADE,
  claim_id BIGINT NOT NULL REFERENCES claim(claim_id),
  confidence NUMERIC(4,3) NOT NULL DEFAULT 1.000,
  PRIMARY KEY (label_id, claim_id)
);

-- Media + swatches
CREATE TABLE image_asset (
  image_id BIGSERIAL PRIMARY KEY,
  owner_type TEXT NOT NULL, -- 'user'|'source'; owner decides image-proxy scope: 'user' rows are served only through owner-scoped v3 ids (#227)
  owner_id BIGINT NOT NULL, -- app_user.user_id when owner_type = 'user' (the v3 id's bound owner)
  storage_url TEXT NOT NULL,
  thumb_url TEXT,
  copyright_status TEXT NOT NULL DEFAULT 'user_uploaded',
  checksum_sha256 TEXT,
  captured_at TIMESTAMPTZ
);

CREATE TABLE swatch (
  swatch_id BIGSERIAL PRIMARY KEY,
  shade_id BIGINT REFERENCES shade(shade_id) ON DELETE CASCADE,
  sku_id BIGINT REFERENCES sku(sku_id) ON DELETE CASCADE,
  image_id_original BIGINT NOT NULL REFERENCES image_asset(image_id),
  image_id_normalized BIGINT REFERENCES image_asset(image_id),
  swatch_type TEXT,
  lighting TEXT,
  background TEXT,
  quality_score NUMERIC(5,2)
);

CREATE TABLE color_features (
  swatch_id BIGINT PRIMARY KEY REFERENCES swatch(swatch_id) ON DELETE CASCADE,
  avg_rgb INT[],          -- [r,g,b]
  avg_lab NUMERIC[],      -- [L,a,b]
  dominant_hex TEXT,
  hue NUMERIC(6,3),
  sat NUMERIC(6,3),
  val NUMERIC(6,3),
  sparkle_score NUMERIC(6,3),
  shimmer_score NUMERIC(6,3),
  embedding vector(512)   -- adjust dimension to your model
);

-- Matching
CREATE TABLE entity_link (
  entity_link_id BIGSERIAL PRIMARY KEY,
  source_record_id BIGINT NOT NULL REFERENCES source_record(source_record_id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL, -- 'shade'|'sku'|'label'|'image'|'brand'|'product_line'
  entity_id BIGINT NOT NULL,
  confidence NUMERIC(4,3) NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed', -- proposed|accepted|rejected|superseded
  evidence_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE match_candidate (
  candidate_id BIGSERIAL PRIMARY KEY,
  source_record_id BIGINT NOT NULL REFERENCES source_record(source_record_id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  candidate_entity_id BIGINT NOT NULL,
  score_total NUMERIC(6,4) NOT NULL,
  score_breakdown_json JSONB,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE match_decision (
  decision_id BIGSERIAL PRIMARY KEY,
  candidate_id BIGINT NOT NULL REFERENCES match_candidate(candidate_id) ON DELETE CASCADE,
  decision TEXT NOT NULL, -- accept|reject
  decided_by TEXT NOT NULL, -- user|mod|auto
  notes TEXT,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Users + inventory
CREATE TABLE app_user (
  user_id BIGSERIAL PRIMARY KEY,
  handle TEXT UNIQUE,
  external_id TEXT UNIQUE,
  email TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  CONSTRAINT app_user_role_check CHECK (role IN ('user', 'admin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE user_external_identities (
  user_external_identity_id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES app_user(user_id) ON DELETE CASCADE,
  external_id TEXT NOT NULL UNIQUE,
  email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_user_external_identities_user_id
  ON user_external_identities(user_id);

CREATE TABLE app_settings (
  setting_key TEXT PRIMARY KEY,
  setting_value JSONB NOT NULL,
  description TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by INTEGER REFERENCES app_user(user_id) ON DELETE SET NULL
);

CREATE TABLE finish_type (
  finish_type_id SMALLSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  description TEXT,
  sort_order SMALLINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by_user_id BIGINT REFERENCES app_user(user_id) ON DELETE SET NULL
);

CREATE TABLE harmony_type (
  harmony_type_id SMALLSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  description TEXT,
  sort_order SMALLINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by_user_id BIGINT REFERENCES app_user(user_id) ON DELETE SET NULL
);

CREATE TABLE user_inventory_item (
  inventory_item_id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES app_user(user_id) ON DELETE CASCADE,
  sku_id BIGINT REFERENCES sku(sku_id),
  shade_id BIGINT REFERENCES shade(shade_id),
  quantity INT NOT NULL DEFAULT 1,
  condition TEXT,
  purchase_date DATE,
  purchase_price NUMERIC(10,2),
  purchase_currency TEXT,          -- ISO 4217 code (e.g. USD), validated by the API
  notes TEXT,
  -- User-facing fields (migrations 002, 004)
  rating SMALLINT CHECK (rating >= 1 AND rating <= 5),
  tags TEXT[] DEFAULT '{}',
  size_display TEXT,
  expiration_date DATE,
  -- Inventory status (migration 20261017061336791_inventory-status). "Untried" is derived:
  -- status = 'owned' AND tried_at IS NULL. It is not a status value.
  status TEXT NOT NULL DEFAULT 'owned'
    CONSTRAINT chk_user_inventory_item_status
    CHECK (status IN ('owned', 'wishlist', 'destash', 'archived')),
  tried_at TIMESTAMPTZ,            -- NULL = untried
  last_worn_at TIMESTAMPTZ,
  wear_count INT NOT NULL DEFAULT 0
    CONSTRAINT chk_user_inventory_item_wear_count CHECK (wear_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_user_inventory_shade UNIQUE (user_id, shade_id)
);

CREATE UNIQUE INDEX idx_user_inventory_unique_shade
  ON user_inventory_item(user_id, shade_id)
  WHERE shade_id IS NOT NULL;

CREATE INDEX idx_user_inventory_status
  ON user_inventory_item(user_id, status);

CREATE TABLE inventory_event (
  inventory_event_id BIGSERIAL PRIMARY KEY,
  inventory_item_id BIGINT NOT NULL REFERENCES user_inventory_item(inventory_item_id) ON DELETE CASCADE,
  event_type TEXT NOT NULL, -- added|updated|sold|decluttered|used|...
  event_payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Contributions (staging)
CREATE TABLE user_submission (
  submission_id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES app_user(user_id) ON DELETE CASCADE,
  submission_type TEXT NOT NULL, -- add_polish|edit_canonical|add_swatch|add_label
  source_context JSONB,          -- gtin, text fields, etc.
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE submission_media (
  submission_media_id BIGSERIAL PRIMARY KEY,
  submission_id BIGINT NOT NULL REFERENCES user_submission(submission_id) ON DELETE CASCADE,
  image_id BIGINT NOT NULL REFERENCES image_asset(image_id),
  purpose TEXT NOT NULL -- bottle|label|swatch|receipt
);

CREATE TABLE submission_fact (
  submission_fact_id BIGSERIAL PRIMARY KEY,
  submission_id BIGINT NOT NULL REFERENCES user_submission(submission_id) ON DELETE CASCADE,
  fact_type TEXT NOT NULL, -- brand|line|shade_name|gtin|inci|claim|...
  fact_value TEXT NOT NULL,
  confidence NUMERIC(4,3) NOT NULL,
  evidence_json JSONB
);

CREATE TABLE proposal_patch (
  proposal_patch_id BIGSERIAL PRIMARY KEY,
  submission_id BIGINT NOT NULL REFERENCES user_submission(submission_id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id BIGINT, -- null when proposing a new entity
  patch_json JSONB NOT NULL,
  confidence NUMERIC(4,3) NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
);

-- Search indexes
CREATE INDEX idx_brand_alias_trgm ON brand_alias USING GIN (alias gin_trgm_ops);
CREATE INDEX idx_shade_name_trgm ON shade USING GIN (shade_name_canonical gin_trgm_ops);
CREATE INDEX idx_swatch_shade_latest ON swatch (shade_id, swatch_id DESC); -- primary-swatch LATERAL lookup in POLISH_SELECT
CREATE INDEX idx_shade_alias_trgm ON shade_alias USING GIN (alias gin_trgm_ops);
CREATE INDEX idx_swatch_embedding ON color_features USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);


-- -----------------------------------------------------------------------------
-- Live Capture Onboarding (Rapid Add)
-- -----------------------------------------------------------------------------

CREATE TABLE capture_session (
  capture_session_id BIGSERIAL PRIMARY KEY,
  capture_uuid UUID NOT NULL UNIQUE,           -- public identifier used by clients
  user_id BIGINT NOT NULL REFERENCES app_user(user_id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'processing',   -- processing|matched|needs_question|unmatched|cancelled
  top_confidence NUMERIC(4,3),
  accepted_entity_type TEXT,                  -- shade|sku|null
  accepted_entity_id BIGINT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE capture_frame (
  capture_frame_id BIGSERIAL PRIMARY KEY,
  capture_session_id BIGINT NOT NULL REFERENCES capture_session(capture_session_id) ON DELETE CASCADE,
  image_id BIGINT NOT NULL REFERENCES image_asset(image_id) ON DELETE CASCADE,
  frame_type TEXT NOT NULL,                   -- barcode|label|color|other
  quality_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE capture_question (
  capture_question_id BIGSERIAL PRIMARY KEY,
  capture_session_id BIGINT NOT NULL REFERENCES capture_session(capture_session_id) ON DELETE CASCADE,
  question_key TEXT NOT NULL,                 -- finish|brand_confirm|barcode|label_photo|...
  prompt TEXT NOT NULL,
  question_type TEXT NOT NULL,                -- single_select|multi_select|free_text|boolean
  options_json JSONB,
  status TEXT NOT NULL DEFAULT 'open',         -- open|answered|skipped|expired
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE capture_answer (
  capture_answer_id BIGSERIAL PRIMARY KEY,
  capture_question_id BIGINT NOT NULL REFERENCES capture_question(capture_question_id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES app_user(user_id) ON DELETE CASCADE,
  answer_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_capture_session_user_status ON capture_session(user_id, status, created_at DESC);
CREATE INDEX idx_capture_frame_session_type ON capture_frame(capture_session_id, frame_type);
CREATE INDEX idx_capture_question_session_status ON capture_question(capture_session_id, status);
CREATE INDEX idx_capture_answer_question ON capture_answer(capture_question_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- Retail Mode + Affiliate Tracking
-- -----------------------------------------------------------------------------

CREATE TABLE retailer (
  retailer_id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  country_codes TEXT[],                       -- e.g. {US,CA,GB}
  supports_deeplink BOOLEAN NOT NULL DEFAULT false,
  app_uri_scheme TEXT,                        -- e.g. ulta://, sephora:// (optional)
  homepage_url TEXT
);

CREATE TABLE affiliate_program (
  affiliate_program_id BIGSERIAL PRIMARY KEY,
  retailer_id BIGINT NOT NULL REFERENCES retailer(retailer_id) ON DELETE CASCADE,
  network TEXT NOT NULL,                      -- impact|rakuten|amazon|direct|...
  publisher_account_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',       -- active|paused|terminated
  terms_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE retailer_offer (
  offer_id BIGSERIAL PRIMARY KEY,
  retailer_id BIGINT NOT NULL REFERENCES retailer(retailer_id) ON DELETE CASCADE,
  canonical_entity_type TEXT NOT NULL,         -- shade|sku
  canonical_entity_id BIGINT NOT NULL,
  product_url TEXT NOT NULL,                  -- direct product page or search URL
  tracking_template TEXT,                     -- affiliate tracking template (optional)
  last_verified_at TIMESTAMPTZ,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE offer_price_snapshot (
  offer_price_snapshot_id BIGSERIAL PRIMARY KEY,
  offer_id BIGINT NOT NULL REFERENCES retailer_offer(offer_id) ON DELETE CASCADE,
  price NUMERIC(10,2),
  currency TEXT,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source TEXT,                                -- manual|feed|api
  metadata JSONB
);

CREATE TABLE click_event (
  click_id BIGSERIAL PRIMARY KEY,
  offer_id BIGINT NOT NULL REFERENCES retailer_offer(offer_id) ON DELETE CASCADE,
  user_id BIGINT REFERENCES app_user(user_id) ON DELETE SET NULL,
  inventory_item_id BIGINT REFERENCES user_inventory_item(user_inventory_item_id) ON DELETE SET NULL,
  platform TEXT,                              -- ios|android|web
  session_uuid UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB
);

CREATE TABLE disclosure_config (
  disclosure_config_id BIGSERIAL PRIMARY KEY,
  env TEXT NOT NULL,                          -- dev|stg|prod
  disclosure_text TEXT NOT NULL,
  last_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(env)
);

CREATE INDEX idx_offer_entity ON retailer_offer(canonical_entity_type, canonical_entity_id);
CREATE INDEX idx_offer_retailer ON retailer_offer(retailer_id, created_at DESC);
CREATE INDEX idx_price_offer_time ON offer_price_snapshot(offer_id, captured_at DESC);
CREATE INDEX idx_click_offer_time ON click_event(offer_id, created_at DESC);
CREATE INDEX idx_click_user_time ON click_event(user_id, created_at DESC);


-- -----------------------------------------------------------------------------
-- External Sources + Provenance (Optional but recommended for MVP scale-up)
-- -----------------------------------------------------------------------------

CREATE TABLE data_source (
  data_source_id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,                   -- e.g., OpenBeautyFacts, Impact, Rakuten, Manual
  source_type TEXT NOT NULL,                   -- api|dump|feed|manual|scrape
  base_url TEXT,
  license TEXT,                               -- license identifier/name (if applicable)
  terms_url TEXT,
  enabled BOOLEAN NOT NULL DEFAULT true,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Connector image URL each source image was downloaded from; ingestion reruns reuse the
-- stored image when the URL is unchanged instead of downloading it again.
CREATE TABLE source_image_url (
  data_source_id BIGINT NOT NULL REFERENCES data_source(data_source_id) ON DELETE CASCADE,
  source_url TEXT NOT NULL,
  image_id BIGINT NOT NULL REFERENCES image_asset(image_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (data_source_id, source_url)
);
CREATE INDEX idx_source_image_url_image ON source_image_url(image_id);

-- Raw external product record keyed (primarily) by GTIN; may include ingredients/labels/etc.
CREATE TABLE external_product (
  external_product_id BIGSERIAL PRIMARY KEY,
  data_source_id BIGINT NOT NULL REFERENCES data_source(data_source_id) ON DELETE CASCADE,
  gtin TEXT,                                   -- GTIN/UPC/EAN as string; not always present
  external_id TEXT,                            -- provider-specific id
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_json JSONB NOT NULL,                     -- raw provider payload for audit
  normalized_json JSONB,                       -- normalized fields extracted
  etag TEXT,
  UNIQUE(data_source_id, external_id),
  UNIQUE(data_source_id, gtin, external_id)
);

CREATE INDEX idx_external_product_gtin ON external_product(gtin);
CREATE INDEX idx_external_product_source_time ON external_product(data_source_id, fetched_at DESC);

-- Which connector product(s) each shade was materialized from (migration
-- 20261017061344201_add-shade-source-product). Drives the "Buy from brand" link (#267):
-- the URL is external_product.normalized_json ->> 'productUrl'; with several products the
-- API prefers an enabled data_source, then the latest last_seen_at (lib/buy-link.ts).
CREATE TABLE shade_source_product (
  shade_id BIGINT NOT NULL REFERENCES shade(shade_id) ON DELETE CASCADE,
  external_product_id BIGINT NOT NULL REFERENCES external_product(external_product_id) ON DELETE CASCADE,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),  -- bumped on every ingestion re-materialization
  PRIMARY KEY (shade_id, external_product_id)
);
CREATE INDEX idx_shade_source_product_external_product ON shade_source_product(external_product_id);

-- Field-level provenance so you can explain "why" and resolve conflicts safely
CREATE TABLE field_provenance (
  field_provenance_id BIGSERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL,                   -- brand|shade|sku|label_document|ingredient|...
  entity_id BIGINT NOT NULL,
  field_name TEXT NOT NULL,                    -- e.g., 'shade_name', 'gtin', 'inci_text'
  data_source_id BIGINT REFERENCES data_source(data_source_id) ON DELETE SET NULL,
  confidence NUMERIC(4,3),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  evidence_image_id BIGINT REFERENCES image_asset(image_id) ON DELETE SET NULL,
  raw_ref TEXT,                                -- pointer into raw payload (jsonpath) or external url
  notes TEXT
);

CREATE INDEX idx_field_prov_entity ON field_provenance(entity_type, entity_id, field_name, observed_at DESC);
CREATE INDEX idx_field_prov_source_time ON field_provenance(data_source_id, observed_at DESC);

-- Track ingestion jobs for bulk loads / periodic syncs
CREATE TABLE ingestion_job (
  ingestion_job_id BIGSERIAL PRIMARY KEY,
  data_source_id BIGINT NOT NULL REFERENCES data_source(data_source_id) ON DELETE CASCADE,
  job_type TEXT NOT NULL,                      -- bulk_sync|incremental_sync|feed_refresh|backfill
  status TEXT NOT NULL DEFAULT 'running',      -- running|succeeded|failed|cancelled
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  metrics_json JSONB,
  error TEXT
);

CREATE INDEX idx_ingestion_job_source_time ON ingestion_job(data_source_id, started_at DESC);


-- -----------------------------------------------------------------------------
-- Color Training Data (for building custom nail polish color AI)
-- -----------------------------------------------------------------------------
--
-- ARCHITECTURE NOTES - Self-Hosted Color AI Path
-- ==============================================
--
-- Goal: Build a portable, self-hosted color AI instead of relying on Azure OpenAI
-- 
-- Current: Ingestion calls Azure OpenAI API → returns hex for color names
-- Target: Self-hosted model that runs locally (no API quotas/limits)
--
-- Path to Self-Hosting:
-- ---------------------
-- 1. COLLECT: Run ingestions with collectTrainingData=true
--    - Stores image_url + ground-truth hex from vendor data
--    - Use vendors with hex in options (Mooncat, Holo Taco, etc.)
--
-- 2. CURATE: Review training samples in color_training_sample
--    - training_status: pending → approved/rejected
--    - Filter out bad samples manually if needed
--
-- 3. TRAIN: Fine-tune a small open-source model
--    - Recommended: Phi-3-mini or Llama 3.2 (small, fast, good quality)
--    - Method: LoRA fine-tuning (low compute, effective)
--    - Tools: Google Colab (free GPU), Hugging Face Transformers, PEFT
--    - Input: color name + brand context → Output: hex
--
-- 4. DEPLOY: Run self-hosted
--    - Option A: Ollama (easiest) - run Phi-3 locally via Docker
--    - Option B: vLLM - higher throughput, needs more RAM
--    - Option C: HF Inference Endpoints - still cloud but portable
--
-- 5. INTEGRATE: Swap Azure for local
--    - In color-name-detection.ts: toggle between Azure and local endpoint
--    - Local endpoint: http://localhost:11434/api/generate (Ollama)
--
-- Benefits:
-- - No per-request costs
-- - No rate limits
-- - Your model learns BRAND-SPECIFIC colors (Mooncat "Wildberry" = specific purple)
-- - Ownership: you own the model
--
-- Example training command (future):
--   python train_color_model.py --samples 5000 --model phi-3-mini --output swatchwatch-color-v1
--

-- Collects image + hex pairs from vendor data for training custom color models
-- When we have ground-truth hex from options, we capture the image for training
CREATE TABLE color_training_sample (
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

-- Indexes for training data queries
CREATE INDEX idx_color_training_hex ON color_training_sample(hex);
CREATE INDEX idx_color_training_brand ON color_training_sample(brand_name);
CREATE INDEX idx_color_training_status ON color_training_sample(training_status);
CREATE INDEX idx_color_training_source_type ON color_training_sample(source_type);
CREATE INDEX idx_color_training_created ON color_training_sample(created_at DESC);

-- Idempotent populate (eval harness): one sample per external product and source type.
CREATE UNIQUE INDEX idx_color_training_external_product_source
  ON color_training_sample(external_product_id, source_type)
  WHERE external_product_id IS NOT NULL;

-- Track which samples have been used for model training
CREATE TABLE color_model_version (
  model_version_id BIGSERIAL PRIMARY KEY,
  model_name TEXT NOT NULL,
  version TEXT NOT NULL,
  training_samples_used INT NOT NULL,
  azure_deployment_name TEXT,                -- if deployed to Azure
  training_started_at TIMESTAMPTZ NOT NULL,
  training_completed_at TIMESTAMPTZ,
  metrics_json JSONB,
  status TEXT NOT NULL DEFAULT 'training',  -- training|deployed|failed|retired
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(model_name, version)
);

CREATE INDEX idx_color_model_status ON color_model_version(status, created_at DESC);
