const BATCH_API_VERSION = "2024-10-01-preview";
const BATCH_FILE_TIMEOUT_MS = 30000;
const MAX_BATCH_BODY_LOG_CHARS = 400;

/**
 * Minimum number of image candidates required to use the Batch API path.
 * Jobs with fewer candidates use the synchronous detection path instead.
 */
export const BATCH_MIN_CANDIDATES = 5;

/** Prefix applied to every custom_id in batch JSONL requests. */
export const BATCH_CUSTOM_ID_PREFIX = "img-";

export interface BatchImageCandidate {
  /** Unique request identifier; use `${BATCH_CUSTOM_ID_PREFIX}${externalId}`. */
  customId: string;
  /** Base64 data URI (preferred) or publicly-accessible image URL. */
  imageUrlOrDataUri: string;
  vendorContext?: {
    shadeName?: string | null;
    vendorHex?: string | null;
    description?: string | null;
    tags?: string[] | null;
  };
}

export interface BatchSubmitResult {
  batchId: string;
  inputFileId: string;
  requestCount: number;
  submittedAt: string;
}

export interface BatchStatusResult {
  batchId: string;
  status:
    | "validating"
    | "failed"
    | "in_progress"
    | "finalizing"
    | "completed"
    | "expired"
    | "cancelling"
    | "cancelled";
  outputFileId: string | null;
  errorFileId: string | null;
  requestCounts: { total: number; completed: number; failed: number };
}

export interface BatchOutputItem {
  customId: string;
  hex: string | null;
  confidence: number | null;
  finishes: string[] | null;
  error: string | null;
}

/**
 * Returns whether the Azure OpenAI Batch API path is enabled.
 *
 * This function reads from `process.env` at **call time** so that the flag is
 * always picked up from the deployed Functions environment without requiring a
 * worker restart.  Do NOT cache this at module load time.
 */
export function isBatchEnabled(): boolean {
  return process.env.AZURE_OPENAI_BATCH_ENABLED?.trim().toLowerCase() === "true";
}

/**
 * Returns whether the batch path should be used for the given candidate count.
 * Falls back to the synchronous path for small jobs.
 */
export function shouldUseBatch(candidateCount: number): boolean {
  return isBatchEnabled() && candidateCount >= BATCH_MIN_CANDIDATES;
}

function getBatchConfig(): {
  endpoint: string;
  apiKey: string;
  deployment: string;
} | null {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT?.trim();
  const apiKey = process.env.AZURE_OPENAI_KEY?.trim();
  const deployment =
    process.env.AZURE_OPENAI_DEPLOYMENT_HEX?.trim() ||
    process.env.AZURE_OPENAI_DEPLOYMENT?.trim();

  if (!endpoint || !apiKey || !deployment) {
    return null;
  }
  return { endpoint: endpoint.replace(/\/+$/, ""), apiKey, deployment };
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BATCH_FILE_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function readBodySnippet(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  return text.length > MAX_BATCH_BODY_LOG_CHARS
    ? `${text.slice(0, MAX_BATCH_BODY_LOG_CHARS)}…`
    : text;
}

function buildVendorContextText(
  ctx: BatchImageCandidate["vendorContext"]
): string | null {
  if (!ctx) return null;
  const payload: Record<string, unknown> = {};
  if (ctx.shadeName) payload.shadeName = ctx.shadeName;
  if (ctx.vendorHex) payload.vendorHex = ctx.vendorHex;
  if (ctx.description) payload.description = ctx.description;
  if (Array.isArray(ctx.tags) && ctx.tags.length > 0) payload.tags = ctx.tags;
  return Object.keys(payload).length ? JSON.stringify(payload) : null;
}

function buildBatchRequestLine(
  candidate: BatchImageCandidate,
  deployment: string
): string {
  const vendorContext = buildVendorContextText(candidate.vendorContext);
  const userContent: Array<Record<string, unknown>> = [
    {
      type: "text",
      text: "Image may show either a bottle product shot or closeup painted nails. Return exactly one hex for the primary marketed base shade. Exclude background, brush, cap, box, and sparkle highlights. Identify any finishes mentioned or visible (creme, shimmer, glitter, metallic, matte, jelly, holographic, duochrome, multichrome, flake, topper, sheer, magnetic, thermal, crelly, velvet, etc.). ALWAYS return a hex value and confidence score. If the image is unclear or unusable, make your best guess and include an 'error' field explaining why confidence is low.",
    },
    ...(vendorContext ? [{ type: "text", text: `Vendor context: ${vendorContext}` }] : []),
    {
      type: "image_url",
      image_url: { url: candidate.imageUrlOrDataUri },
    },
  ];

  const requestBody = {
    model: deployment,
    temperature: 0,
    max_tokens: 120,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "You extract the primary base polish color and finishes from a nail polish product image. Ignore background, props, packaging/box, labels/text, bottle cap, nail brush, and glare. For glitter/shimmer/holo finishes, infer the underlying base lacquer color, not reflective particles. ALWAYS respond with valid JSON containing hex, confidence, finishes array, and optional error. Format: {\"hex\":\"#RRGGBB\",\"confidence\":0..1,\"finishes\":[\"creme\",\"shimmer\",...],\"error\":\"reason if low confidence\"}.",
      },
      {
        role: "user",
        content: userContent,
      },
    ],
  };

  const line = {
    custom_id: candidate.customId,
    method: "POST",
    url: "/chat/completions",
    body: requestBody,
  };

  return JSON.stringify(line);
}

/**
 * Uploads a JSONL file of batch requests to the Azure OpenAI Files endpoint
 * and returns the file ID.
 */
async function uploadBatchFile(
  jsonlContent: string,
  config: { endpoint: string; apiKey: string }
): Promise<string> {
  const url = `${config.endpoint}/openai/files?api-version=${BATCH_API_VERSION}`;

  const encoder = new TextEncoder();
  const fileBytes = encoder.encode(jsonlContent);

  const formData = new FormData();
  formData.append("purpose", "batch");
  formData.append(
    "file",
    new Blob([fileBytes], { type: "application/jsonl" }),
    "batch_input.jsonl"
  );

  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "api-key": config.apiKey },
    body: formData,
  });

  if (!response.ok) {
    const details = await readBodySnippet(response);
    throw new Error(
      `[openai-batch] File upload failed: status=${response.status}, body=${details || "n/a"}`
    );
  }

  const body = (await response.json()) as { id?: string };
  if (!body.id) {
    throw new Error("[openai-batch] File upload response missing id");
  }
  return body.id;
}

/**
 * Creates an Azure OpenAI Batch job from a previously-uploaded file.
 * Returns the batch ID.
 */
async function createBatchJob(
  inputFileId: string,
  config: { endpoint: string; apiKey: string }
): Promise<string> {
  const url = `${config.endpoint}/openai/batches?api-version=${BATCH_API_VERSION}`;

  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": config.apiKey,
    },
    body: JSON.stringify({
      input_file_id: inputFileId,
      endpoint: "/chat/completions",
      completion_window: "24h",
    }),
  });

  if (!response.ok) {
    const details = await readBodySnippet(response);
    throw new Error(
      `[openai-batch] Batch create failed: status=${response.status}, body=${details || "n/a"}`
    );
  }

  const body = (await response.json()) as { id?: string };
  if (!body.id) {
    throw new Error("[openai-batch] Batch create response missing id");
  }
  return body.id;
}

/**
 * Submits a list of image candidates as a single Azure OpenAI Batch job.
 * Uploads the JSONL file first, then creates the batch.
 */
export async function submitBatch(
  candidates: BatchImageCandidate[]
): Promise<BatchSubmitResult> {
  if (candidates.length === 0) {
    throw new Error("[openai-batch] Cannot submit empty batch");
  }

  const config = getBatchConfig();
  if (!config) {
    throw new Error(
      "[openai-batch] Missing Azure OpenAI config (AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_KEY, AZURE_OPENAI_DEPLOYMENT_HEX)"
    );
  }

  const lines = candidates.map((c) => buildBatchRequestLine(c, config.deployment));
  const jsonlContent = lines.join("\n");

  const inputFileId = await uploadBatchFile(jsonlContent, config);
  const batchId = await createBatchJob(inputFileId, config);

  return {
    batchId,
    inputFileId,
    requestCount: candidates.length,
    submittedAt: new Date().toISOString(),
  };
}

/**
 * Retrieves the current status of an Azure OpenAI Batch job.
 */
export async function getBatchStatus(batchId: string): Promise<BatchStatusResult> {
  const config = getBatchConfig();
  if (!config) {
    throw new Error("[openai-batch] Missing Azure OpenAI config");
  }

  const url = `${config.endpoint}/openai/batches/${batchId}?api-version=${BATCH_API_VERSION}`;

  const response = await fetchWithTimeout(url, {
    method: "GET",
    headers: { "api-key": config.apiKey },
  });

  if (!response.ok) {
    const details = await readBodySnippet(response);
    throw new Error(
      `[openai-batch] Get batch status failed: status=${response.status}, body=${details || "n/a"}`
    );
  }

  const body = (await response.json()) as {
    id?: string;
    status?: string;
    output_file_id?: string | null;
    error_file_id?: string | null;
    request_counts?: { total?: number; completed?: number; failed?: number };
  };

  return {
    batchId: body.id || batchId,
    status: (body.status || "failed") as BatchStatusResult["status"],
    outputFileId: body.output_file_id ?? null,
    errorFileId: body.error_file_id ?? null,
    requestCounts: {
      total: body.request_counts?.total ?? 0,
      completed: body.request_counts?.completed ?? 0,
      failed: body.request_counts?.failed ?? 0,
    },
  };
}

function normalizeHex(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^#?([0-9a-fA-F]{6})$/);
  return match ? `#${match[1].toUpperCase()}` : null;
}

function parseConfidence(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.min(1, value));
  }
  if (typeof value === "string") {
    const n = Number.parseFloat(value);
    if (Number.isFinite(n)) return Math.max(0, Math.min(1, n));
  }
  return null;
}

function parseFinishesRaw(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out = value
    .filter((e) => typeof e === "string")
    .map((e) => (e as string).trim().toLowerCase())
    .filter(Boolean);
  return out.length ? out : null;
}

function parseSingleBatchOutputLine(
  line: string
): BatchOutputItem | null {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const customId = typeof parsed.custom_id === "string" ? parsed.custom_id : null;
    if (!customId) return null;

    // Error path
    if (parsed.error && typeof parsed.error === "object") {
      return { customId, hex: null, confidence: null, finishes: null, error: "batch_request_error" };
    }

    const response = parsed.response as Record<string, unknown> | null;
    if (!response) {
      return { customId, hex: null, confidence: null, finishes: null, error: "missing_response" };
    }

    const statusCode =
      typeof response.status_code === "number" ? response.status_code : 0;
    if (statusCode !== 200) {
      return {
        customId,
        hex: null,
        confidence: null,
        finishes: null,
        error: `response_status_${statusCode}`,
      };
    }

    const body = response.body as Record<string, unknown> | undefined;
    const content = (
      body?.choices as Array<{ message?: { content?: string | null } }> | undefined
    )?.[0]?.message?.content;

    if (!content || typeof content !== "string") {
      return { customId, hex: null, confidence: null, finishes: null, error: "empty_content" };
    }

    try {
      const inner = JSON.parse(content) as Record<string, unknown>;
      const hex = normalizeHex(inner.hex);
      const confidence = parseConfidence(inner.confidence);
      const finishes = parseFinishesRaw(inner.finishes);
      const error = typeof inner.error === "string" ? inner.error : null;
      return { customId, hex, confidence, finishes, error };
    } catch {
      // Regex fallback
      const hex = normalizeHex(content.match(/#?[0-9a-fA-F]{6}/)?.[0]);
      return { customId, hex, confidence: null, finishes: null, error: "json_parse_error" };
    }
  } catch {
    return null;
  }
}

/**
 * Downloads the output file for a completed batch and parses it into
 * per-request result objects.
 */
export async function parseBatchOutput(outputFileId: string): Promise<BatchOutputItem[]> {
  const config = getBatchConfig();
  if (!config) {
    throw new Error("[openai-batch] Missing Azure OpenAI config");
  }

  const url = `${config.endpoint}/openai/files/${outputFileId}/content?api-version=${BATCH_API_VERSION}`;

  const response = await fetchWithTimeout(url, {
    method: "GET",
    headers: { "api-key": config.apiKey },
  });

  if (!response.ok) {
    const details = await readBodySnippet(response);
    throw new Error(
      `[openai-batch] Download output file failed: status=${response.status}, body=${details || "n/a"}`
    );
  }

  const text = await response.text();
  const results: BatchOutputItem[] = [];

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const item = parseSingleBatchOutputLine(trimmed);
    if (item) {
      results.push(item);
    }
  }

  return results;
}
