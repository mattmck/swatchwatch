export interface ResolveAzureOpenAiConfigOptions {
  deploymentEnvKeys: string[];
}

export interface ResolvedAzureOpenAiConfig {
  useGateway: boolean;
  effectiveUseGateway: boolean;
  endpoint: string | null;
  directEndpoint: string | null;
  gatewayEndpoint: string | null;
  apiKey: string | null;
  gatewaySubscriptionKey: string | null;
  deployment: string | null;
  hasAuthHeader: boolean;
  headers: Record<string, string>;
  isValid: boolean;
  missingGatewayPrerequisites: string[];
}

function trimEnv(key: string): string | null {
  const value = process.env[key]?.trim();
  return value ? value : null;
}

export function resolveAzureOpenAiConfig(
  options: ResolveAzureOpenAiConfigOptions
): ResolvedAzureOpenAiConfig {
  const directEndpoint = trimEnv("AZURE_OPENAI_ENDPOINT");
  const gatewayEndpoint = trimEnv("AZURE_OPENAI_GATEWAY_ENDPOINT");
  const useGateway = trimEnv("AZURE_OPENAI_USE_GATEWAY")?.toLowerCase() === "true";
  const apiKey = trimEnv("AZURE_OPENAI_KEY");
  const gatewaySubscriptionKey = trimEnv("AZURE_OPENAI_GATEWAY_SUBSCRIPTION_KEY");
  const deployment =
    options.deploymentEnvKeys
      .map((key) => trimEnv(key))
      .find((value): value is string => !!value) || null;

  const missingGatewayPrerequisites: string[] = [];
  if (useGateway && !gatewayEndpoint) {
    missingGatewayPrerequisites.push("AZURE_OPENAI_GATEWAY_ENDPOINT");
  }
  if (useGateway && !gatewaySubscriptionKey) {
    missingGatewayPrerequisites.push("AZURE_OPENAI_GATEWAY_SUBSCRIPTION_KEY");
  }

  const effectiveUseGateway = useGateway && missingGatewayPrerequisites.length === 0;
  const endpoint = (effectiveUseGateway ? gatewayEndpoint : directEndpoint) || null;
  const hasAuthHeader = effectiveUseGateway ? !!gatewaySubscriptionKey : !!apiKey;
  const headers: Record<string, string> = {};
  if (effectiveUseGateway && gatewaySubscriptionKey) {
    headers["Ocp-Apim-Subscription-Key"] = gatewaySubscriptionKey;
  } else if (apiKey) {
    headers["api-key"] = apiKey;
  }

  return {
    useGateway,
    effectiveUseGateway,
    endpoint: endpoint ? endpoint.replace(/\/+$/, "") : null,
    directEndpoint,
    gatewayEndpoint,
    apiKey,
    gatewaySubscriptionKey,
    deployment,
    hasAuthHeader,
    headers,
    isValid: !!endpoint && hasAuthHeader && !!deployment,
    missingGatewayPrerequisites,
  };
}
