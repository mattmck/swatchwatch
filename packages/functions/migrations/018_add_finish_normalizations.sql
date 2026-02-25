-- Up Migration

-- 018_add_finish_normalizations.sql
-- Adds editable finish normalization mappings for AI-extracted finish text.

BEGIN;

CREATE TABLE IF NOT EXISTS finish_normalization (
  finish_normalization_id BIGSERIAL PRIMARY KEY,
  source_value TEXT NOT NULL UNIQUE,
  normalized_finish_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by_user_id BIGINT REFERENCES app_user(user_id) ON DELETE SET NULL,
  CONSTRAINT finish_normalization_normalized_finish_name_fkey
    FOREIGN KEY (normalized_finish_name)
    REFERENCES finish_type(name)
    ON DELETE RESTRICT
);

-- Backfill canonical finish_type rows required by normalization mappings.
-- Some older environments may be missing one or more of these values.
INSERT INTO finish_type (name, display_name, description, sort_order) VALUES
  ('creme', 'Creme', 'Opaque, no shimmer or sparkle', 1),
  ('sheer', 'Sheer', 'Translucent, buildable coverage', 2),
  ('jelly', 'Jelly', 'Translucent with a squishy, glossy look', 3),
  ('shimmer', 'Shimmer', 'Fine light-reflecting particles', 4),
  ('metallic', 'Metallic', 'Foil-like, mirror-finish sheen', 5),
  ('glitter', 'Glitter', 'Visible glitter particles in a clear or tinted base', 6),
  ('holographic', 'Holographic', 'Prismatic rainbow effect (linear or scattered)', 7),
  ('duochrome', 'Duochrome', 'Shifts between two colors at different angles', 8),
  ('multichrome', 'Multichrome', 'Shifts across three or more colors', 9),
  ('flake', 'Flake', 'Irregular metallic or iridescent flakes', 10),
  ('matte', 'Matte', 'Non-shiny, flat finish (may need matte top coat)', 11),
  ('topper', 'Topper', 'Meant to layer over another polish', 12),
  ('magnetic', 'Magnetic', 'Contains iron particles shaped with a magnet', 13),
  ('thermal', 'Thermal', 'Color changes with temperature', 14),
  ('crelly', 'Crelly', 'Cream/jelly hybrid; semi-sheer squishy base', 15),
  ('glow', 'Glow', 'Glow-in-the-dark or UV-reactive', 16)
ON CONFLICT (name) DO NOTHING;

INSERT INTO finish_normalization (source_value, normalized_finish_name) VALUES
  ('creme', 'creme'),
  ('cream', 'creme'),
  ('creamy', 'creme'),
  ('shimmer', 'shimmer'),
  ('glitter', 'glitter'),
  ('metallic', 'metallic'),
  ('matte', 'matte'),
  ('jelly', 'jelly'),
  ('holographic', 'holographic'),
  ('holo', 'holographic'),
  ('holo finish', 'holographic'),
  ('crushed holo', 'holographic'),
  ('crushed-holo', 'holographic'),
  ('crushedholo', 'holographic'),
  ('linear holo', 'holographic'),
  ('linear-holo', 'holographic'),
  ('linearholo', 'holographic'),
  ('scattered holo', 'holographic'),
  ('scattered-holo', 'holographic'),
  ('scatteredholo', 'holographic'),
  ('micro holo', 'holographic'),
  ('micro-holo', 'holographic'),
  ('microholo', 'holographic'),
  ('holo glitter', 'holographic'),
  ('holo-glitter', 'holographic'),
  ('holographic glitter', 'holographic'),
  ('holo flake', 'holographic'),
  ('holo-flake', 'holographic'),
  ('holo flakes', 'holographic'),
  ('holo-flakes', 'holographic'),
  ('duochrome', 'duochrome'),
  ('multichrome', 'multichrome'),
  ('flake', 'flake'),
  ('flakes', 'flake'),
  ('topper', 'topper'),
  ('sheer', 'sheer'),
  ('magnetic', 'magnetic'),
  ('thermal', 'thermal'),
  ('crelly', 'crelly'),
  ('glow', 'glow'),
  ('glow in the dark', 'glow'),
  ('glow-in-the-dark', 'glow'),
  ('gitd', 'glow')
ON CONFLICT (source_value) DO NOTHING;

COMMIT;

-- Down Migration

BEGIN;

DROP TABLE IF EXISTS finish_normalization;

COMMIT;
