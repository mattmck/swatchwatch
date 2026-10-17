/**
 * Browser telemetry (Azure Application Insights), mirroring the Functions
 * `lib/telemetry.ts` API: `trackEvent`, `trackException`, plus `setUser` /
 * `clearUser` for the signed-in user.
 *
 * The SDK is loaded with a dynamic `import()` the first time telemetry is
 * needed (normally from `TelemetryProvider`'s effect, i.e. after hydration), so
 * it lands in its own chunk and stays out of the critical bundle. Everything
 * is a no-op on the server and when
 * `NEXT_PUBLIC_APPLICATIONINSIGHTS_CONNECTION_STRING` is unset (local dev).
 * Calls made before the SDK finishes loading are queued and replayed.
 */
import type {
  ApplicationInsights,
  IConfig,
  IConfiguration,
  ITelemetryItem,
} from "@microsoft/applicationinsights-web";

export type TelemetryEnv = {
  connectionString?: string;
  apiUrl?: string;
  sampling?: string;
};

export type TelemetryConfig = IConfiguration & IConfig;

// Literal `process.env.NEXT_PUBLIC_*` reads so Next inlines them into the
// static export at build time.
const BUILD_ENV: TelemetryEnv = {
  connectionString: process.env.NEXT_PUBLIC_APPLICATIONINSIGHTS_CONNECTION_STRING,
  apiUrl: process.env.NEXT_PUBLIC_API_URL,
  sampling: process.env.NEXT_PUBLIC_APPINSIGHTS_SAMPLING,
};

// Same fallback as `lib/api.ts`.
const DEFAULT_API_URL = "http://localhost:7071/api";

// `DistributedTracingModes.W3C` (sends `traceparent`/`tracestate`). Inlined so
// building the config doesn't pull the SDK into the main bundle.
const DISTRIBUTED_TRACING_W3C = 2;

const MAX_PENDING_CALLS = 100;

export function parseSamplingPercentage(raw: string | undefined): number {
  const trimmed = raw?.trim();
  if (!trimmed) return 100;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0 || value > 100) return 100;
  return value;
}

/** Host (with any non-default port) of the Functions API, or null when it isn't an absolute URL. */
export function apiHostFrom(apiUrl: string | undefined): string | null {
  try {
    return new URL(apiUrl?.trim() || DEFAULT_API_URL).host.toLowerCase() || null;
  } catch {
    return null;
  }
}

export function buildTelemetryConfig(env: TelemetryEnv = BUILD_ENV): TelemetryConfig | null {
  const connectionString = env.connectionString?.trim();
  if (!connectionString) return null;

  // Correlation headers go only to the API host. Never enable CORS correlation
  // without that allow-list: other origins (B2C login, blob storage) would
  // reject `traceparent` on preflight. A relative API URL is same-origin and
  // gets the headers without CORS correlation.
  const apiHost = apiHostFrom(env.apiUrl);

  return {
    connectionString,
    enableAutoRouteTracking: true,
    enableUnhandledPromiseRejectionTracking: true,
    distributedTracingMode: DISTRIBUTED_TRACING_W3C,
    enableCorsCorrelation: apiHost !== null,
    correlationHeaderDomains: apiHost ? [apiHost] : [],
    samplingPercentage: parseSamplingPercentage(env.sampling),
    // Cookies (ai_user / ai_session) power the Users & Sessions blades. Open
    // decision in docs/observability-plan.md: set true to drop them.
    disableCookiesUsage: false,
  };
}

// `/api/images/{id}` ids are HMAC-signed read capabilities; keep them out of
// telemetry (retained for 30 days).
const IMAGE_PROXY_ID = /(\/api\/images\/)[^/?#\s"']+/g;

export function redactImageProxyIds(value: string): string {
  return value.replace(IMAGE_PROXY_ID, "$1[redacted]");
}

// Shareable-wishlist tokens (#268) are read capabilities too: the API path
// `/api/wishlist/{token}` and the public page's `?token=` query parameter.
const WISHLIST_API_TOKEN = /(\/api\/wishlist\/)[^/?#\s"']+/g;
const TOKEN_QUERY_PARAM = /([?&]token=)[^&#\s"']+/g;

export function redactWishlistTokens(value: string): string {
  return value.replace(WISHLIST_API_TOKEN, "$1[redacted]").replace(TOKEN_QUERY_PARAM, "$1[redacted]");
}

/** Redacts every capability (image proxy ids, wishlist share tokens) in a string. */
export function redactCapabilities(value: string): string {
  return redactWishlistTokens(redactImageProxyIds(value));
}

function redactStrings(record: unknown): void {
  if (!record || typeof record !== "object") return;
  const fields = record as Record<string, unknown>;
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === "string") {
      fields[key] = redactCapabilities(value);
    }
  }
}

/**
 * Telemetry initializer: redacts image-proxy ids and wishlist share tokens in dependency, page
 * view and custom fields.
 */
export function redactImageUrlsInitializer(item: ITelemetryItem): boolean {
  redactStrings(item.baseData);
  redactStrings(item.baseData?.properties);
  redactStrings(item.data);
  redactStrings(item.tags);
  return true;
}

function toProperties(
  properties?: Record<string, unknown>,
): Record<string, string> | undefined {
  if (!properties) return undefined;

  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (value === null || typeof value === "undefined") continue;
    normalized[key] = typeof value === "string" ? value : String(value);
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

type TelemetryCall = (client: ApplicationInsights) => void;

const config = typeof window === "undefined" ? null : buildTelemetryConfig();
let client: ApplicationInsights | null = null;
let loading: Promise<void> | null = null;
const pending: TelemetryCall[] = [];

function run(call: TelemetryCall, target: ApplicationInsights): void {
  try {
    call(target);
  } catch {
    // Telemetry must never break the page.
  }
}

/** Loads and starts the SDK once. Safe to call repeatedly; a no-op when telemetry is off. */
export function initTelemetry(): Promise<void> {
  if (!config) return Promise.resolve();

  loading ??= import("@microsoft/applicationinsights-web")
    .then(({ ApplicationInsights }) => {
      const appInsights = new ApplicationInsights({ config });
      appInsights.loadAppInsights();
      appInsights.addTelemetryInitializer(redactImageUrlsInitializer);
      // Route changes are tracked automatically; the first page view isn't.
      appInsights.trackPageView();
      client = appInsights;
      for (const call of pending.splice(0)) run(call, appInsights);
    })
    .catch((error) => {
      pending.length = 0;
      console.warn("[telemetry] Failed to load Application Insights:", error);
    });

  return loading;
}

function withClient(call: TelemetryCall): void {
  if (!config) return;
  if (client) {
    run(call, client);
    return;
  }
  if (pending.length < MAX_PENDING_CALLS) pending.push(call);
  void initTelemetry();
}

export function isTelemetryEnabled(): boolean {
  return config !== null;
}

export function trackEvent(name: string, properties?: Record<string, unknown>): void {
  withClient((ai) => ai.trackEvent({ name, properties: toProperties(properties) }));
}

export function trackException(error: unknown, properties?: Record<string, unknown>): void {
  const exception = error instanceof Error ? error : new Error(String(error));
  withClient((ai) =>
    ai.trackException({ exception, properties: toProperties(properties) }),
  );
}

/** Tags telemetry with the internal SwatchWatch user id. Never pass an email. */
export function setUser(userId: string): void {
  withClient((ai) => ai.setAuthenticatedUserContext(userId));
}

export function clearUser(): void {
  withClient((ai) => ai.clearAuthenticatedUserContext());
}
