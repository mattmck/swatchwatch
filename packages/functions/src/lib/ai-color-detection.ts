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
  provider: "azure-openai" | "none";
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

function parseConfidence(value: unknown): number | null {
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

const FINISH_CANONICAL: Record<string, string> = {
  creme: "creme",
  cream: "creme",
  creamy: "creme",
  shimmer: "shimmer",
  glitter: "glitter",
  metallic: "metallic",
  matte: "matte",
  jelly: "jelly",
  holographic: "holographic",
  holo: "holographic",
  duochrome: "duochrome",
  multichrome: "multichrome",
  flake: "flake",
  flakes: "flake",
  topper: "topper",
  sheer: "sheer",
  magnetic: "magnetic",
  thermal: "thermal",
  crelly: "crelly",
};

function parseFinishes(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const normalized = entry.trim().toLowerCase();
    const mapped = FINISH_CANONICAL[normalized];
    if (mapped && !out.includes(mapped)) {
      out.push(mapped);
    }
  }
  return out.length ? out : null;
}

function parseHexFromContent(
  content: string,
  imageUrl: string,
  options?: HexDetectionOptions
): HexDetectionResult {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const hex = normalizeHex(parsed.hex);
    const confidence = parseConfidence(parsed.confidence);
    const finishes = parseFinishes(parsed.finishes);
    const errorReason = typeof parsed.error === "string" ? parsed.error : null;

    if (errorReason) {
      emitLog(options, "info", `[ai-color-detection] Low confidence for ${imageUrl}: ${errorReason}`);
    }

    if (hex) {
      return { hex, confidence, finishes, provider: "azure-openai" };
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
    provider: "azure-openai",
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
 *   Data URIs are preferred because Azure OpenAI fetches URL images server-side, which fails for
 *   localhost (Azurite) URLs and Shopify CDN URLs with bot protection.
 */
export async function detectHexWithAzureOpenAI(
  imageUrlOrDataUri: string,
  options?: HexDetectionOptions
): Promise<HexDetectionResult> {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT?.trim();
  const apiKey = process.env.AZURE_OPENAI_KEY?.trim();
  const deployment =
    process.env.AZURE_OPENAI_DEPLOYMENT_HEX?.trim() ||
    process.env.AZURE_OPENAI_DEPLOYMENT?.trim();

  if (!endpoint || !apiKey || !deployment) {
    emitLog(options, "error", `[ai-color-detection] Missing Azure OpenAI config`, {
      hasEndpoint: !!endpoint,
      hasApiKey: !!apiKey,
      hasDeployment: !!deployment,
      availableEnvVars: {
        AZURE_OPENAI_ENDPOINT: process.env.AZURE_OPENAI_ENDPOINT ? "set" : "missing",
        AZURE_OPENAI_KEY: process.env.AZURE_OPENAI_KEY ? "set" : "missing",
        AZURE_OPENAI_DEPLOYMENT_HEX: process.env.AZURE_OPENAI_DEPLOYMENT_HEX ? "set" : "missing",
        AZURE_OPENAI_DEPLOYMENT: process.env.AZURE_OPENAI_DEPLOYMENT ? "set" : "missing",
      },
    });
    return { hex: null, confidence: null, finishes: null, provider: "none" };
  }

  const logLabel = imageUrlOrDataUri.startsWith("data:") ? "data:…(base64)" : imageUrlOrDataUri;
  const vendorContext = buildVendorContext(options);
  emitLog(options, "info", `[ai-color-detection] Config loaded, calling Azure OpenAI for ${logLabel}`);

  const requestUrl = `${endpoint.replace(/\/+$/, "")}/openai/deployments/${deployment}/chat/completions?api-version=${OPENAI_API_VERSION}`;
  const createRequestInit = (safePrompt: boolean): RequestInit => ({
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": apiKey,
    },
    body: JSON.stringify({
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
                    "Return exactly one hex code for the primary polish shade. Ignore non-polish areas and reflections. Also identify all finishes mentioned or visible (e.g., creme, shimmer, glitter, metallic, matte, jelly, holographic, duochrome, multichrome, flake, topper, sheer, magnetic, thermal, crelly). If uncertain, provide best guess with low confidence.",
                },
                ...(vendorContext ? [{ type: "text", text: `Vendor context: ${vendorContext}` }] : []),
                {
                  type: "image_url",
                  image_url: { url: imageUrlOrDataUri },
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
                    "Image may show either a bottle product shot or closeup painted nails. Return exactly one hex for the primary marketed base shade. Exclude background, brush, cap, box, and sparkle highlights. Identify any finishes mentioned or visible (creme, shimmer, glitter, metallic, matte, jelly, holographic, duochrome, multichrome, flake, topper, sheer, magnetic, thermal, crelly). ALWAYS return a hex value and confidence score. If the image is unclear or unusable, make your best guess and include an 'error' field explaining why confidence is low.",
                },
                ...(vendorContext ? [{ type: "text", text: `Vendor context: ${vendorContext}` }] : []),
                {
                  type: "image_url",
                  image_url: { url: imageUrlOrDataUri },
                },
              ],
            },
          ],
    }),
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
      return { hex: null, confidence: null, provider: "azure-openai" };
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
  };
  const content = body.choices?.[0]?.message?.content;
  if (!content || typeof content !== "string") {
    return { hex: null, confidence: null, provider: "azure-openai" };
  }

  return parseHexFromContent(content, logLabel, options);
}
