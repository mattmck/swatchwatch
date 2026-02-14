-- Add default ingestion settings to data_source metadata
-- This adds per-source controls for image downloading and hex detection

BEGIN;

-- Update existing sources with default settings in metadata
UPDATE data_source
SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
  'ingestion', jsonb_build_object(
    'downloadImages', true,
    'detectHex', true,
    'overwriteExisting', false
  )
)
WHERE metadata IS NULL 
   OR metadata->'ingestion' IS NULL;

-- Add a global app_settings table for system-wide configuration
CREATE TABLE IF NOT EXISTS app_settings (
    setting_key TEXT PRIMARY KEY,
    setting_value JSONB NOT NULL,
    description TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by INTEGER REFERENCES app_user(user_id)
);

-- Insert default global settings if not exist
INSERT INTO app_settings (setting_key, setting_value, description)
VALUES 
    ('ingestion', '{"downloadImages": true, "detectHex": true}'::jsonb, 'Global ingestion settings')
ON CONFLICT (setting_key) DO NOTHING;


COMMIT;
