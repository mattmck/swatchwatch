-- Normalize finish values: rename "cream" -> "creme" for consistency.
-- This is idempotent and safe to run multiple times.

BEGIN;

UPDATE shade
SET finish = 'creme'
WHERE finish = 'cream';

COMMIT;
