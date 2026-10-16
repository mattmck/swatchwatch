import { canonicalizeFinishes, loadFinishCatalog } from "./finishes";
import { trackMetric } from "./telemetry";
import { resolveAzureOpenAiConfig } from "./azure-openai-config";

const OPENAI_API_VERSION = "2024-05-01-preview";
const REQUEST_TIMEOUT_MS = 20000;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 2000;
const RATE_LIMIT_DELAY_MS = 10000;
const MAX_ERROR_BODY_LOG_CHARS = 400;

export interface HexDetectionResult {
  hex: string | null;
  confidence: number | null;
  finishes: string[] | null;
  usage?: HexDetectionTokenUsage | null;
  provider: "azure-openai" | "none";
}

export interface HexDetectionTokenUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
}

export type HexDetectionLogLevel = "info" | "warn" | "error";

export interface HexDetectionOptions {
  onLog?: (
    level: HexDetectionLogLevel,
    message: string,
    data?: Record<string, unknown>
  ) => void;
  vendorContext?: {
    shadeName?: string | null;
    vendorHex?: string | null;
    description?: string | null;
    tags?: string[] | null;
    vendorJson?: Record<string, unknown> | null;
  };
}

export type VisionImageDetail = "low" | "high" | "auto";

const VISION_IMAGE_DETAILS: readonly VisionImageDetail[] = ["low", "high", "auto"];

interface HexDetectionRequestPayload {
  temperature: number;
  max_tokens: number;
  response_format: { type: "json_object" };
  messages: Array<{
    role: "system" | "user";
    content:
      | string
      | Array<{
          type: string;
          text?: string;
          image_url?: { url: string; detail: VisionImageDetail };
        }>;
  }>;
}

/**
 * Vision detail level for hex detection. "low" sends a single 512px view
 * (flat ~85 tokens) instead of high-detail tiles — the base lacquer hex
 * survives downsampling. Override via AZURE_OPENAI_VISION_DETAIL if finish
 * detection (glitter/flake/holo) needs more resolution.
 */
function resolveVisionImageDetail(): VisionImageDetail {
  const raw = process.env.AZURE_OPENAI_VISION_DETAIL?.trim().toLowerCase();
  return VISION_IMAGE_DETAILS.find((detail) => detail === raw) ?? "low";
}

function emitLog(
  options: HexDetectionOptions | undefined,
  level: HexDetectionLogLevel,
  message: string,
  data?: Record<string, unknown>
): void {
  if (level === "error") {
    console.error(message, data ?? "");
  } else if (level === "warn") {
    console.warn(message, data ?? "");
  } else {
    console.log(message, data ?? "");
  }

  options?.onLog?.(level, message, data);
}

function normalizeHex(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  const match = trimmed.match(/^#?([0-9a-fA-F]{6})$/);
  if (!match) {
    return null;
  }

  return `#${match[1].toUpperCase()}`;
}

export function parseConfidence(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.min(1, value));
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.min(1, parsed));
    }
  }
  return null;
}

function parseTokenCount(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return null;
}

export function parseHexDetectionTokenUsage(
  value: unknown
): HexDetectionTokenUsage | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const row = value as Record<string, unknown>;
  const promptTokens = parseTokenCount(row.prompt_tokens);
  const completionTokens = parseTokenCount(row.completion_tokens);
  const totalTokens = parseTokenCount(row.total_tokens);

  if (
    promptTokens === null &&
    completionTokens === null &&
    totalTokens === null
  ) {
    return null;
  }

  return {
    promptTokens,
    completionTokens,
    totalTokens,
  };
}

/** Canonicalize a model-returned finishes array against the runtime finish catalog (null when empty/invalid). */
export async function parseDetectedFinishes(
  value: unknown,
  options?: Pick<HexDetectionOptions, "onLog">
): Promise<string[] | null> {
  if (!Array.isArray(value)) return null;
  // Uses the runtime finish catalog so admin-added finish types are accepted too.
  const catalog = await loadFinishCatalog({
    onFallback: (message, code) =>
      emitLog(
        options,
        "warn",
        `[ai-color-detection] Falling back to built-in finish catalog (${message})`,
        { code }
      ),
  });
  const out = canonicalizeFinishes(value, catalog);
  return out.length ? out : null;
}

export async function parseHexDetectionContent(
  content: string,
  imageUrl: string,
  options?: HexDetectionOptions,
  usage?: HexDetectionTokenUsage | null
): Promise<HexDetectionResult> {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const hex = normalizeHex(parsed.hex);
    const confidence = parseConfidence(parsed.confidence);
    const finishes = await parseDetectedFinishes(parsed.finishes, options);
    const errorReason = typeof parsed.error === "string" ? parsed.error : null;

    if (errorReason) {
      emitLog(options, "info", `[ai-color-detection] Low confidence for ${imageUrl}: ${errorReason}`);
    }

    if (hex) {
      return { hex, confidence, finishes, usage: usage || null, provider: "azure-openai" };
    }

    emitLog(options, "warn", `[ai-color-detection] No valid hex in response for ${imageUrl}: ${content}`);
  } catch (err) {
    emitLog(
      options,
      "warn",
      `[ai-color-detection] JSON parse error for ${imageUrl}: ${err instanceof Error ? err.message : String(err)}, content: ${content}`
    );
  }

  const fallbackMatch = content.match(/#?[0-9a-fA-F]{6}/);
  const hex = normalizeHex(fallbackMatch?.[0]);
  if (!hex) {
    emitLog(options, "warn", `[ai-color-detection] Regex fallback also failed for ${imageUrl}`);
  }
  return {
    hex,
    confidence: null,
    finishes: null,
    usage: usage || null,
    provider: "azure-openai",
  };
}

export function buildHexDetectionRequestPayload(
  imageUrlOrDataUri: string,
  options?: Pick<HexDetectionOptions, "vendorContext">,
  safePrompt = false
): HexDetectionRequestPayload {
  const vendorContext = buildVendorContext({
    vendorContext: options?.vendorContext,
  });
  const imageUrl = { url: imageUrlOrDataUri, detail: resolveVisionImageDetail() };

  return {
    temperature: 0,
    max_tokens: 120,
    response_format: { type: "json_object" },
    messages: safePrompt
      ? [
          {
            role: "system",
            content:
              "Return one representative base polish color from the product image. Respond with valid JSON only: {\"hex\":\"#RRGGBB\",\"confidence\":0..1,\"finishes\":[\"creme\",\"shimmer\",...],\"error\":\"optional\"}. Always include hex and confidence.",
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  "Return exactly one hex code for the primary polish shade. Ignore non-polish areas and reflections. Also identify all finishes mentioned or visible (e.g., creme, shimmer, glitter, metallic, matte, jelly, holographic, duochrome, multichrome, flake, topper, sheer, magnetic, thermal, crelly, velvet, etc.). If uncertain, provide best guess with low confidence.",
              },
              ...(vendorContext ? [{ type: "text", text: `Vendor context: ${vendorContext}` }] : []),
              {
                type: "image_url",
                image_url: imageUrl,
              },
            ],
          },
        ]
      : [
          {
            role: "system",
            content:
              "You extract the primary base polish color and finishes from a nail polish product image. Ignore background, props, packaging/box, labels/text, bottle cap, nail brush, and glare. For glitter/shimmer/holo finishes, infer the underlying base lacquer color, not reflective particles. ALWAYS respond with valid JSON containing hex, confidence, finishes array, and optional error. Format: {\"hex\":\"#RRGGBB\",\"confidence\":0..1,\"finishes\":[\"creme\",\"shimmer\",...],\"error\":\"reason if low confidence\"}.",
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  "Image may show either a bottle product shot or closeup painted nails. Return exactly one hex for the primary marketed base shade. Exclude background, brush, cap, box, and sparkle highlights. Identify any finishes mentioned or visible (creme, shimmer, glitter, metallic, matte, jelly, holographic, duochrome, multichrome, flake, topper, sheer, magnetic, thermal, crelly, velvet, etc.). ALWAYS return a hex value and confidence score. If the image is unclear or unusable, make your best guess and include an 'error' field explaining why confidence is low.",
              },
              ...(vendorContext ? [{ type: "text", text: `Vendor context: ${vendorContext}` }] : []),
              {
                type: "image_url",
                image_url: imageUrl,
              },
            ],
          },
        ],
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfter(response: Response): number | null {
  const retryAfter = response.headers.get("retry-after");
  if (!retryAfter) {
    return null;
  }
  const seconds = parseInt(retryAfter, 10);
  if (Number.isFinite(seconds) && seconds > 0) {
    return seconds * 1000;
  }
  return null;
}

function buildVendorContext(options?: HexDetectionOptions): string | null {
  const ctx = options?.vendorContext;
  if (!ctx) return null;
  const payload: Record<string, unknown> = {};
  if (ctx.shadeName) payload.shadeName = ctx.shadeName;
  if (ctx.vendorHex) payload.vendorHex = ctx.vendorHex;
  if (ctx.description) payload.description = ctx.description;
  if (Array.isArray(ctx.tags) && ctx.tags.length > 0) payload.tags = ctx.tags;
  if (ctx.vendorJson) {
    try {
      const json = JSON.stringify(ctx.vendorJson);
      payload.vendorJson = json.length > 1800 ? `${json.slice(0, 1800)}…` : ctx.vendorJson;
    } catch {
      // ignore serialization errors
    }
  }
  return Object.keys(payload).length ? JSON.stringify(payload) : null;
}

function getResponseId(response: Response): string {
  return (
    response.headers.get("x-request-id") ||
    response.headers.get("apim-request-id") ||
    response.headers.get("x-ms-request-id") ||
    "n/a"
  );
}

async function readErrorBodySnippet(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  if (!text) {
    return "";
  }
  return text.length > MAX_ERROR_BODY_LOG_CHARS
    ? `${text.slice(0, MAX_ERROR_BODY_LOG_CHARS)}…`
    : text;
}

function formatFetchError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

function isContentFilterResponse(status: number, details: string): boolean {
  if (status !== 400) {
    return false;
  }
  const lower = details.toLowerCase();
  return lower.includes("content_filter") || lower.includes("responsibleaipolicyviolation");
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options?: HexDetectionOptions
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const attemptNumber = attempt + 1;
    try {
      const response = await fetchWithTimeout(url, init);

      if (response.status === 429) {
        const retryAfter = parseRetryAfter(response) || RATE_LIMIT_DELAY_MS;
        const delay = Math.min(retryAfter, 60000);
        const requestId = getResponseId(response);
        emitLog(
          options,
          "warn",
          `[ai-color-detection] Azure OpenAI rate-limited (429) attempt ${attemptNumber}/${MAX_RETRIES}, retrying in ${delay}ms (requestId=${requestId})`,
          {
            status: response.status,
            attemptNumber,
            maxRetries: MAX_RETRIES,
            delayMs: delay,
            requestId,
          }
        );
        await sleep(delay);
        continue;
      }

      if (response.status >= 500 && attempt < MAX_RETRIES - 1) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        const requestId = getResponseId(response);
        const bodySnippet = await readErrorBodySnippet(response);
        emitLog(
          options,
          "warn",
          `[ai-color-detection] Azure OpenAI server error ${response.status} attempt ${attemptNumber}/${MAX_RETRIES}, retrying in ${delay}ms (requestId=${requestId}, body=${bodySnippet || "n/a"})`,
          {
            status: response.status,
            attemptNumber,
            maxRetries: MAX_RETRIES,
            delayMs: delay,
            requestId,
            body: bodySnippet || undefined,
          }
        );
        await sleep(delay);
        continue;
      }

      return response;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const delay = BASE_DELAY_MS * Math.pow(2, attempt);
      emitLog(
        options,
        "warn",
        `[ai-color-detection] Request error attempt ${attemptNumber}/${MAX_RETRIES}: ${formatFetchError(error)}${
          attempt < MAX_RETRIES - 1 ? `, retrying in ${delay}ms` : ""
        }`,
        {
          attemptNumber,
          maxRetries: MAX_RETRIES,
          delayMs: attempt < MAX_RETRIES - 1 ? delay : undefined,
          error: formatFetchError(error),
        }
      );
      if (attempt < MAX_RETRIES - 1) {
        await sleep(delay);
      }
    }
  }

  if (lastError) {
    emitLog(options, "error", `[ai-color-detection] Exhausted retries: ${formatFetchError(lastError)}`);
  }
  throw lastError || new Error("Request failed after retries");
}

export type AzureOpenAIChatCompletionReason = "missing_config" | "content_filtered" | "empty_response";

export interface AzureOpenAIChatCompletionRequest {
  /**
   * Builds the chat-completions request body. Called with `safePrompt = true`
   * when the first attempt is rejected by the Azure content filter, so callers
   * can supply a toned-down prompt for the retry.
   */
  buildPayload: (safePrompt: boolean) => unknown;
  /** Env keys consulted (in order) for the deployment name. */
  deploymentEnvKeys?: string[];
  /** Prefix for token-usage metrics (`<prefix>.prompt_tokens`, ...); omit to skip metrics. */
  usageMetricPrefix?: string | null;
  /** Label used in log lines instead of the (possibly huge) image payload. */
  logLabel?: string;
}

export interface AzureOpenAIChatCompletionResponse {
  provider: "azure-openai" | "none";
  /** Assistant message content, or null (see `reason`). */
  content: string | null;
  usage: HexDetectionTokenUsage | null;
  /** Set when `content` is null. */
  reason?: AzureOpenAIChatCompletionReason;
}

const DEFAULT_DEPLOYMENT_ENV_KEYS = ["AZURE_OPENAI_DEPLOYMENT_HEX", "AZURE_OPENAI_DEPLOYMENT"];

/**
 * Lower-level Azure OpenAI chat-completions call shared by the hex detectors:
 * config resolution (direct or APIM gateway), timeout + retry on 429/5xx,
 * one content-filter retry with a safe prompt, token-usage metrics. Returns
 * the raw assistant content so callers own their prompt and parsing.
 *
 * Throws on non-retryable HTTP errors and when retries are exhausted; returns
 * `provider: "none"` when the config is missing and `content: null` with a
 * `reason` when the content filter persisted or the response was empty.
 */
export async function requestAzureOpenAIChatCompletion(
  request: AzureOpenAIChatCompletionRequest,
  options?: Pick<HexDetectionOptions, "onLog">
): Promise<AzureOpenAIChatCompletionResponse> {
  const resolved = resolveAzureOpenAiConfig({
    deploymentEnvKeys: request.deploymentEnvKeys ?? DEFAULT_DEPLOYMENT_ENV_KEYS,
  });
  const {
    useGateway,
    effectiveUseGateway,
    endpoint,
    apiKey,
    gatewaySubscriptionKey,
    deployment,
    missingGatewayPrerequisites,
    headers: authHeaders,
  } = resolved;

  if (useGateway && !effectiveUseGateway) {
    emitLog(
      options,
      "warn",
      "[ai-color-detection] AZURE_OPENAI_USE_GATEWAY=true but gateway prerequisites are missing; falling back to direct endpoint",
      {
        missingGatewayPrerequisites,
        hasDirectEndpoint: !!resolved.directEndpoint,
        hasApiKey: !!apiKey,
      }
    );
  }

  if (!resolved.isValid || !endpoint || !deployment) {
    emitLog(options, "error", `[ai-color-detection] Missing Azure OpenAI config`, {
      hasEndpoint: !!endpoint,
      hasDirectEndpoint: !!resolved.directEndpoint,
      hasGatewayEndpoint: !!resolved.gatewayEndpoint,
      hasApiKey: !!apiKey,
      hasGatewaySubscriptionKey: !!gatewaySubscriptionKey,
      hasDeployment: !!deployment,
      useGateway,
      effectiveUseGateway,
      missingGatewayPrerequisites,
      availableEnvVars: {
        AZURE_OPENAI_ENDPOINT: process.env.AZURE_OPENAI_ENDPOINT ? "set" : "missing",
        AZURE_OPENAI_KEY: process.env.AZURE_OPENAI_KEY ? "set" : "missing",
        AZURE_OPENAI_GATEWAY_ENDPOINT: process.env.AZURE_OPENAI_GATEWAY_ENDPOINT ? "set" : "missing",
        AZURE_OPENAI_GATEWAY_SUBSCRIPTION_KEY: process.env.AZURE_OPENAI_GATEWAY_SUBSCRIPTION_KEY ? "set" : "missing",
        AZURE_OPENAI_USE_GATEWAY: process.env.AZURE_OPENAI_USE_GATEWAY ? "set" : "missing",
        AZURE_OPENAI_DEPLOYMENT_HEX: process.env.AZURE_OPENAI_DEPLOYMENT_HEX ? "set" : "missing",
        AZURE_OPENAI_DEPLOYMENT: process.env.AZURE_OPENAI_DEPLOYMENT ? "set" : "missing",
      },
    });
    return { provider: "none", content: null, usage: null, reason: "missing_config" };
  }

  const logLabel = request.logLabel ?? "request";
  emitLog(options, "info", `[ai-color-detection] Config loaded, calling Azure OpenAI for ${logLabel}`);

  const requestUrl = `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${OPENAI_API_VERSION}`;
  const createRequestInit = (safePrompt: boolean): RequestInit => ({
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders,
    },
    body: JSON.stringify(request.buildPayload(safePrompt)),
  });

  let response = await fetchWithRetry(requestUrl, createRequestInit(false), options);

  if (!response.ok) {
    const details = await readErrorBodySnippet(response);
    const requestId = getResponseId(response);
    if (isContentFilterResponse(response.status, details)) {
      emitLog(
        options,
        "warn",
        `[ai-color-detection] Content filter hit, retrying with safer prompt (requestId=${requestId})`,
        {
          status: response.status,
          requestId,
          body: details || undefined,
        }
      );
      response = await fetchWithRetry(requestUrl, createRequestInit(true), options);
    } else {
      emitLog(
        options,
        "error",
        `[ai-color-detection] Azure OpenAI non-OK response: status=${response.status}, requestId=${requestId}, body=${details || "n/a"}`,
        {
          status: response.status,
          requestId,
          body: details || undefined,
        }
      );
      throw new Error(`Azure OpenAI hex detection failed: ${response.status} ${details}`);
    }
  }

  if (!response.ok) {
    const details = await readErrorBodySnippet(response);
    const requestId = getResponseId(response);
    if (isContentFilterResponse(response.status, details)) {
      emitLog(
        options,
        "warn",
        `[ai-color-detection] Content filter persisted after safe retry, skipping image (requestId=${requestId})`,
        {
          status: response.status,
          requestId,
          body: details || undefined,
        }
      );
      return { provider: "azure-openai", content: null, usage: null, reason: "content_filtered" };
    }

    emitLog(
      options,
      "error",
      `[ai-color-detection] Azure OpenAI non-OK response: status=${response.status}, requestId=${requestId}, body=${details || "n/a"}`,
      {
        status: response.status,
        requestId,
        body: details || undefined,
      }
    );
    throw new Error(`Azure OpenAI hex detection failed: ${response.status} ${details}`);
  }

  const body = (await response.json()) as {
    choices?: Array<{
      message?: { content?: string | null };
    }>;
    usage?: {
      prompt_tokens?: unknown;
      completion_tokens?: unknown;
      total_tokens?: unknown;
    };
  };
  const usage = parseHexDetectionTokenUsage(body.usage);
  if (usage) {
    emitLog(options, "info", `[ai-color-detection] Azure OpenAI token usage`, usage as unknown as Record<string, unknown>);
    const metricPrefix = request.usageMetricPrefix;
    if (metricPrefix) {
      const metricProperties = {
        provider: "azure-openai",
        deployment,
      };
      if (typeof usage.promptTokens === "number") {
        trackMetric(`${metricPrefix}.prompt_tokens`, usage.promptTokens, metricProperties);
      }
      if (typeof usage.completionTokens === "number") {
        trackMetric(`${metricPrefix}.completion_tokens`, usage.completionTokens, metricProperties);
      }
      if (typeof usage.totalTokens === "number") {
        trackMetric(`${metricPrefix}.total_tokens`, usage.totalTokens, metricProperties);
      }
    }
  }
  const content = body.choices?.[0]?.message?.content;
  if (!content || typeof content !== "string") {
    return { provider: "azure-openai", content: null, usage: usage || null, reason: "empty_response" };
  }

  return { provider: "azure-openai", content, usage: usage || null };
}

/**
 * Detect hex color from an image using Azure OpenAI vision.
 * @param imageUrlOrDataUri - Either a publicly-accessible URL or a base64 data URI (data:image/...;base64,...).
 *   Azure OpenAI fetches image URLs server-side, so the URL must be publicly reachable from Azure
 *   (for example, a proxied blob URL). Localhost or other private-network URLs will not work; for
 *   local development or private origins, prefer base64 data URIs. When available, public URLs are
 *   still preferred to avoid large base64 payloads.
 */
export async function detectHexWithAzureOpenAI(
  imageUrlOrDataUri: string,
  options?: HexDetectionOptions
): Promise<HexDetectionResult> {
  const logLabel = imageUrlOrDataUri.startsWith("data:") ? "data:…(base64)" : imageUrlOrDataUri;
  const response = await requestAzureOpenAIChatCompletion(
    {
      buildPayload: (safePrompt) =>
        buildHexDetectionRequestPayload(imageUrlOrDataUri, { vendorContext: options?.vendorContext }, safePrompt),
      deploymentEnvKeys: DEFAULT_DEPLOYMENT_ENV_KEYS,
      usageMetricPrefix: "hex_detection.sync",
      logLabel,
    },
    options
  );

  if (response.provider === "none") {
    return { hex: null, confidence: null, finishes: null, usage: null, provider: "none" };
  }
  if (response.content === null) {
    return { hex: null, confidence: null, finishes: null, usage: response.usage, provider: "azure-openai" };
  }

  return parseHexDetectionContent(response.content, logLabel, options, response.usage);
}
