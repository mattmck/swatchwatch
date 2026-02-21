import appInsights from "applicationinsights";

const connectionString = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING?.trim();

let client: appInsights.TelemetryClient | null = null;

if (connectionString) {
  appInsights
    .setup(connectionString)
    // Request telemetry is already collected by Azure Functions runtime.
    .setAutoCollectRequests(false)
    .setAutoCollectDependencies(true)
    .setAutoCollectExceptions(false)
    .setAutoCollectConsole(false)
    .start();

  client = appInsights.defaultClient;
}

function toProperties(
  properties?: Record<string, unknown>
): Record<string, string> | undefined {
  if (!properties) return undefined;

  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (value === null || typeof value === "undefined") {
      continue;
    }
    normalized[key] = typeof value === "string" ? value : String(value);
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function trackEvent(
  name: string,
  properties?: Record<string, unknown>
): void {
  try {
    client?.trackEvent({
      name,
      properties: toProperties(properties),
    });
  } catch {
    // Telemetry should never impact request handling.
  }
}

export function trackMetric(
  name: string,
  value: number,
  properties?: Record<string, unknown>
): void {
  try {
    client?.trackMetric({
      name,
      value,
      properties: toProperties(properties),
    });
  } catch {
    // Telemetry should never impact request handling.
  }
}

export function trackException(
  error: unknown,
  properties?: Record<string, unknown>
): void {
  try {
    const exception = error instanceof Error ? error : new Error(String(error));
    client?.trackException({
      exception,
      properties: toProperties(properties),
    });
  } catch {
    // Telemetry should never impact request handling.
  }
}
