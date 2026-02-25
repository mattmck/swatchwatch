BEGIN;

-- Store AI-detected finishes (array) separate from canonical finish.
ALTER TABLE shade
  ADD COLUMN IF NOT EXISTS detected_finishes text[];

COMMIT;
