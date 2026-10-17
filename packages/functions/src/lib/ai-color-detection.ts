import { canonicalizeFinishes, loadFinishCatalog } from "./finishes";
import { trackMetric } from "./telemetry";
import { resolveAzureOpenAiConfig } from "./azure-openai-config";

const OPENAI_API_VERSION = "2024-05-01-preview";
const REQUEST_TIMEOUT_MS = 20000;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 2000;
const RATE_LIMIT_DELAY_MS = 10000;
const MAX_ERROR_BODY_LOG_CHARS = 400;

/**
 * Revision of the vision prompt in `buildHexDetectionRequestPayload`. Bump it
 * whenever the system/user prompt text, temperature, or response contract
 * changes so detections made with different prompts can be told apart
 * (`shade.detected_hex_prompt_version`).
 */
export const PROMPT_VERSION = "vision-direct/2026-10-v1";

/** Detection strategy identifier stored in `shade.detected_hex_method`. */
export const HEX_DETECTION_METHOD_VISION_DIRECT = "vision-direct";

/**
 * Detection strategies. `vision-direct` is the single-call Azure OpenAI vision
 * prompt; the others are reserved for the strategies under evaluation in
 * `src/eval/hex/` (palette pick, region crop, ensemble).
 */
export type HexDetectionMethod =
  | "vision-direct"
  | "palette-pick"
  | "region-crop"
  | "ensemble"
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  | (string & {});

export interface HexDetectionResult {
  hex: string | null;
  confidence: number | null;
  finishes: string[] | null;
  usage?: HexDetectionTokenUsage | null;
  provider: "azure-openai" | "none";
  /** Strategy that produced `hex` (`vision-direct` for this module). */
  method?: HexDetectionMethod | null;
  /** Azure OpenAI deployment name that answered (stored as `shade.detected_hex_model`). */
  model?: string | null;
  /** `PROMPT_VERSION` the request was built with. */
  promptVersion?: string | null;
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

export interface HexDetectionRequestPayload {
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
export function resolveVisionImageDetail(): VisionImageDetail {
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

async function parseFinishes(
  value: unknown,
  options?: HexDetectionOptions
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
    const finishes = await parseFinishes(parsed.finishes, options);
    const errorReason = typeof parsed.error === "string" ? parsed.error : null;

    if (errorReason) {
      emitLog(options, "info", `[ai-color-detection] Low confidence for ${imageUrl}: ${errorReason}`);
    }

    if (hex) {
      return {
        hex,
        confidence,
        finishes,
        usage: usage || null,
        provider: "azure-openai",
        method: HEX_DETECTION_METHOD_VISION_DIRECT,
        promptVersion: PROMPT_VERSION,
      };
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
    method: HEX_DETECTION_METHOD_VISION_DIRECT,
    promptVersion: PROMPT_VERSION,
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
  const resolved = resolveAzureOpenAiConfig({
    deploymentEnvKeys: ["AZURE_OPENAI_DEPLOYMENT_HEX", "AZURE_OPENAI_DEPLOYMENT"],
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
    return { hex: null, confidence: null, finishes: null, usage: null, provider: "none" };
  }

  const logLabel = imageUrlOrDataUri.startsWith("data:") ? "data:…(base64)" : imageUrlOrDataUri;
  emitLog(options, "info", `[ai-color-detection] Config loaded, calling Azure OpenAI for ${logLabel}`);

  const requestUrl = `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${OPENAI_API_VERSION}`;
  const createRequestInit = (safePrompt: boolean): RequestInit => ({
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders,
    },
    body: JSON.stringify(
      buildHexDetectionRequestPayload(
        imageUrlOrDataUri,
        { vendorContext: options?.vendorContext },
        safePrompt
      )
    ),
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
      return { hex: null, confidence: null, finishes: null, usage: null, provider: "azure-openai" };
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
    const metricProperties = {
      provider: "azure-openai",
      deployment,
    };
    if (typeof usage.promptTokens === "number") {
      trackMetric("hex_detection.sync.prompt_tokens", usage.promptTokens, metricProperties);
    }
    if (typeof usage.completionTokens === "number") {
      trackMetric(
        "hex_detection.sync.completion_tokens",
        usage.completionTokens,
        metricProperties
      );
    }
    if (typeof usage.totalTokens === "number") {
      trackMetric("hex_detection.sync.total_tokens", usage.totalTokens, metricProperties);
    }
  }
  const content = body.choices?.[0]?.message?.content;
  if (!content || typeof content !== "string") {
    return {
      hex: null,
      confidence: null,
      finishes: null,
      usage: usage || null,
      provider: "azure-openai",
      method: HEX_DETECTION_METHOD_VISION_DIRECT,
      model: deployment,
      promptVersion: PROMPT_VERSION,
    };
  }

  const parsed = await parseHexDetectionContent(content, logLabel, options, usage);
  return { ...parsed, model: deployment };
}

export interface AzureOpenAiChatCompletionOptions {
  onLog?: HexDetectionOptions["onLog"];
  /** Env keys consulted (in order) for the deployment name. Defaults to the hex-detection keys. */
  deploymentEnvKeys?: string[];
  /** Short label for log lines (never log data URIs). Default `"request"`. */
  label?: string;
}

export interface AzureOpenAiChatCompletionResult {
  provider: "azure-openai" | "none";
  /** `choices[0].message.content`, or null when the response had none or was content-filtered. */
  content: string | null;
  usage: HexDetectionTokenUsage | null;
  /** True when the content filter rejected the request and the safe retry (or there was none). */
  contentFiltered: boolean;
}

/**
 * Lower-level Azure OpenAI chat-completion call with the same plumbing as
 * `detectHexWithAzureOpenAI` (config resolution, timeout, 429/5xx retry,
 * content-filter safe retry) but a caller-supplied payload. `buildPayload(false)`
 * is the normal request; `buildPayload(true)` is the safer rewording used when
 * the content filter rejects the first one (return null to skip that retry).
 * Returns `provider: "none"` when the config is missing. Used by the eval
 * harness strategies; the production hex prompt still goes through
 * `detectHexWithAzureOpenAI`.
 */
export async function requestAzureOpenAiChatCompletion(
  buildPayload: (safePrompt: boolean) => HexDetectionRequestPayload | null,
  options?: AzureOpenAiChatCompletionOptions
): Promise<AzureOpenAiChatCompletionResult> {
  const logOptions: HexDetectionOptions | undefined = options?.onLog ? { onLog: options.onLog } : undefined;
  const label = options?.label ?? "request";
  const resolved = resolveAzureOpenAiConfig({
    deploymentEnvKeys: options?.deploymentEnvKeys ?? ["AZURE_OPENAI_DEPLOYMENT_HEX", "AZURE_OPENAI_DEPLOYMENT"],
  });
  if (!resolved.isValid || !resolved.endpoint || !resolved.deployment) {
    emitLog(logOptions, "error", `[ai-color-detection] Missing Azure OpenAI config for ${label}`, {
      hasEndpoint: !!resolved.endpoint,
      hasAuthHeader: resolved.hasAuthHeader,
      hasDeployment: !!resolved.deployment,
      missingGatewayPrerequisites: resolved.missingGatewayPrerequisites,
    });
    return { provider: "none", content: null, usage: null, contentFiltered: false };
  }

  const requestUrl = `${resolved.endpoint}/openai/deployments/${resolved.deployment}/chat/completions?api-version=${OPENAI_API_VERSION}`;
  const createRequestInit = (payload: HexDetectionRequestPayload): RequestInit => ({
    method: "POST",
    headers: { "Content-Type": "application/json", ...resolved.headers },
    body: JSON.stringify(payload),
  });

  const firstPayload = buildPayload(false);
  if (!firstPayload) {
    throw new Error("buildPayload(false) must return a request payload");
  }
  let response = await fetchWithRetry(requestUrl, createRequestInit(firstPayload), logOptions);

  if (!response.ok) {
    const details = await readErrorBodySnippet(response);
    const requestId = getResponseId(response);
    if (!isContentFilterResponse(response.status, details)) {
      emitLog(logOptions, "error", `[ai-color-detection] Azure OpenAI non-OK response for ${label}: status=${response.status}, requestId=${requestId}, body=${details || "n/a"}`);
      throw new Error(`Azure OpenAI ${label} failed: ${response.status} ${details}`);
    }
    const safePayload = buildPayload(true);
    if (!safePayload) {
      emitLog(logOptions, "warn", `[ai-color-detection] Content filter hit for ${label}, no safe retry (requestId=${requestId})`);
      return { provider: "azure-openai", content: null, usage: null, contentFiltered: true };
    }
    emitLog(logOptions, "warn", `[ai-color-detection] Content filter hit for ${label}, retrying with safer prompt (requestId=${requestId})`);
    response = await fetchWithRetry(requestUrl, createRequestInit(safePayload), logOptions);
    if (!response.ok) {
      const retryDetails = await readErrorBodySnippet(response);
      if (isContentFilterResponse(response.status, retryDetails)) {
        emitLog(logOptions, "warn", `[ai-color-detection] Content filter persisted after safe retry for ${label}`);
        return { provider: "azure-openai", content: null, usage: null, contentFiltered: true };
      }
      throw new Error(`Azure OpenAI ${label} failed: ${response.status} ${retryDetails}`);
    }
  }

  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | null } }>;
    usage?: unknown;
  };
  const usage = parseHexDetectionTokenUsage(body.usage);
  const content = body.choices?.[0]?.message?.content;
  return {
    provider: "azure-openai",
    content: typeof content === "string" && content ? content : null,
    usage,
    contentFiltered: false,
  };
}
