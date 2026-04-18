import { resolveAzureOpenAiConfig } from "./azure-openai-config";

const OPENAI_API_VERSION = "2024-06-01";
const REQUEST_TIMEOUT_MS = 15000;
const RATE_LIMIT_RETRY_DELAY_MS = 2000;
const MAX_ERROR_BODY_LOG_CHARS = 400;
const LOG_PREFIX = "[ocr-parser]";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ParsedLabelFields {
  brand: string | null;
  shadeName: string | null;
  finish: string | null;
  collection: string | null;
  gtin: string | null;
  sizeMl: number | null;
  confidence: number;
  rawFields: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT =
  "You are a nail polish label reader. Given OCR text from a nail polish bottle label, extract the following fields as JSON: brand, shadeName, finish (one of: creme, shimmer, glitter, metallic, matte, jelly, holographic, holo, duochrome, multichrome, flake, topper, sheer), collection, gtin (if a barcode number is visible), sizeMl. Return ONLY valid JSON. If a field cannot be determined, set it to null.";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function readErrorBodySnippet(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  if (!text) return "";
  return text.length > MAX_ERROR_BODY_LOG_CHARS
    ? `${text.slice(0, MAX_ERROR_BODY_LOG_CHARS)}…`
    : text;
}

function getResponseId(response: Response): string {
  return (
    response.headers.get("x-request-id") ||
    response.headers.get("apim-request-id") ||
    response.headers.get("x-ms-request-id") ||
    "n/a"
  );
}

function asStringOrNull(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return null;
}

function asSizeMl(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return null;
}

function asConfidence(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.min(1, value));
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.min(1, parsed));
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// User prompt builder
// ---------------------------------------------------------------------------

function buildUserMessage(
  rawText: string,
  hints?: { brand?: string; shadeName?: string; finish?: string }
): string {
  const parts: string[] = [`OCR text:\n${rawText}`];

  if (hints) {
    const hintLines: string[] = [];
    if (hints.brand) hintLines.push(`brand: ${hints.brand}`);
    if (hints.shadeName) hintLines.push(`shadeName: ${hints.shadeName}`);
    if (hints.finish) hintLines.push(`finish: ${hints.finish}`);
    if (hintLines.length > 0) {
      parts.push(`\nHints (may help disambiguate):\n${hintLines.join("\n")}`);
    }
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Parse OCR text from a nail polish bottle label using Azure OpenAI.
 *
 * Returns structured fields extracted by the LLM, or `null` when:
 * - Azure OpenAI configuration is unavailable (graceful degradation)
 * - An unrecoverable error occurs during the API call
 */
export async function parseLabelText(
  rawText: string,
  hints?: { brand?: string; shadeName?: string; finish?: string }
): Promise<ParsedLabelFields | null> {
  // -----------------------------------------------------------------------
  // Resolve config — label-specific deployment first, then standard chain
  // -----------------------------------------------------------------------
  const resolved = resolveAzureOpenAiConfig({
    deploymentEnvKeys: [
      "AZURE_OPENAI_DEPLOYMENT_LABEL",
      "AZURE_OPENAI_DEPLOYMENT_HEX",
      "AZURE_OPENAI_DEPLOYMENT",
    ],
  });

  if (!resolved.isValid || !resolved.endpoint || !resolved.deployment) {
    console.warn(
      `${LOG_PREFIX} Azure OpenAI config unavailable — returning null`,
      {
        hasEndpoint: !!resolved.endpoint,
        hasDeployment: !!resolved.deployment,
        hasAuth: resolved.hasAuthHeader,
      }
    );
    return null;
  }

  // -----------------------------------------------------------------------
  // Build request
  // -----------------------------------------------------------------------
  const requestUrl = `${resolved.endpoint}/openai/deployments/${resolved.deployment}/chat/completions?api-version=${OPENAI_API_VERSION}`;

  const requestBody = JSON.stringify({
    temperature: 0.1,
    max_tokens: 500,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserMessage(rawText, hints) },
    ],
  });

  const requestInit: RequestInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...resolved.headers,
    },
    body: requestBody,
  };

  // -----------------------------------------------------------------------
  // Call with single 429 retry
  // -----------------------------------------------------------------------
  let response: Response;
  try {
    response = await fetchWithTimeout(requestUrl, requestInit);

    if (response.status === 429) {
      const requestId = getResponseId(response);
      console.warn(
        `${LOG_PREFIX} Rate-limited (429), retrying once in ${RATE_LIMIT_RETRY_DELAY_MS}ms (requestId=${requestId})`
      );
      await sleep(RATE_LIMIT_RETRY_DELAY_MS);
      response = await fetchWithTimeout(requestUrl, requestInit);
    }
  } catch (error) {
    console.error(
      `${LOG_PREFIX} Fetch error: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }

  if (!response.ok) {
    const details = await readErrorBodySnippet(response);
    const requestId = getResponseId(response);
    console.error(
      `${LOG_PREFIX} Azure OpenAI non-OK response: status=${response.status}, requestId=${requestId}, body=${details || "n/a"}`
    );
    return null;
  }

  // -----------------------------------------------------------------------
  // Parse response
  // -----------------------------------------------------------------------
  let body: {
    choices?: Array<{ message?: { content?: string | null } }>;
    usage?: Record<string, unknown>;
  };
  try {
    body = (await response.json()) as typeof body;
  } catch (error) {
    console.error(
      `${LOG_PREFIX} Failed to parse response JSON: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }

  const content = body.choices?.[0]?.message?.content;
  if (!content || typeof content !== "string") {
    console.warn(`${LOG_PREFIX} Empty content in LLM response`);
    return null;
  }

  // -----------------------------------------------------------------------
  // Parse LLM JSON and validate field types
  // -----------------------------------------------------------------------
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch (error) {
    console.error(
      `${LOG_PREFIX} Failed to parse LLM content as JSON: ${error instanceof Error ? error.message : String(error)}, content: ${content}`
    );
    return null;
  }

  // Store the full LLM response for audit
  const rawFields: Record<string, unknown> = {
    ...parsed,
    _usage: body.usage ?? null,
  };

  return {
    brand: asStringOrNull(parsed.brand),
    shadeName: asStringOrNull(parsed.shadeName),
    finish: asStringOrNull(parsed.finish),
    collection: asStringOrNull(parsed.collection),
    gtin: asStringOrNull(parsed.gtin),
    sizeMl: asSizeMl(parsed.sizeMl),
    confidence: asConfidence(parsed.confidence),
    rawFields,
  };
}
