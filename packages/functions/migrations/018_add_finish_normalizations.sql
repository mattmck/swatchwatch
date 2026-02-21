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
