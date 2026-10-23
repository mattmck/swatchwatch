export interface ResolveAzureOpenAiConfigOptions {
  deploymentEnvKeys: string[];
}

export interface ResolvedAzureOpenAiConfig {
  /** `AZURE_OPENAI_ENDPOINT` with trailing slashes removed, or null when unset. */
  endpoint: string | null;
  apiKey: string | null;
  /** First non-empty value among `deploymentEnvKeys`, in order. */
  deployment: string | null;
  hasAuthHeader: boolean;
  /** `api-key` header when `AZURE_OPENAI_KEY` is set. */
  headers: Record<string, string>;
  isValid: boolean;
}

function trimEnv(key: string): string | null {
  const value = process.env[key]?.trim();
  return value ? value : null;
}

/**
 * Resolves the Azure OpenAI endpoint, key and deployment from the environment.
 * Calls always go straight to the Azure OpenAI resource with `AZURE_OPENAI_KEY`
 * in the `api-key` header; the APIM gateway path was removed (#158, #228).
 */
export function resolveAzureOpenAiConfig(
  options: ResolveAzureOpenAiConfigOptions
): ResolvedAzureOpenAiConfig {
  const endpoint = trimEnv("AZURE_OPENAI_ENDPOINT");
  const apiKey = trimEnv("AZURE_OPENAI_KEY");
  const deployment =
    options.deploymentEnvKeys
      .map((key) => trimEnv(key))
      .find((value): value is string => !!value) || null;

  const hasAuthHeader = !!apiKey;
  const headers: Record<string, string> = {};
  if (apiKey) {
    headers["api-key"] = apiKey;
  }

  return {
    endpoint: endpoint ? endpoint.replace(/\/+$/, "") : null,
    apiKey,
    deployment,
    hasAuthHeader,
    headers,
    isValid: !!endpoint && hasAuthHeader && !!deployment,
  };
}
