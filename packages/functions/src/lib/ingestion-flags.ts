function parseBooleanEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === null) {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return defaultValue;
}

/**
 * Global toggle for image-based hex detection. Allows disabling Azure OpenAI vision
 * calls via function app settings (INGESTION_HEX_FROM_IMAGE_ENABLED=false).
 */
export function isImageHexDetectionEnabled(): boolean {
  return parseBooleanEnv(process.env.INGESTION_HEX_FROM_IMAGE_ENABLED, true);
}

/**
 * Helper exposed for tests or other callers that may need custom defaults.
 */
export function parseEnvFlag(value: string | undefined, defaultValue: boolean): boolean {
  return parseBooleanEnv(value, defaultValue);
}
