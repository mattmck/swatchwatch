import {
  buildHexDetectionRequestPayload,
  parseHexDetectionContent,
  parseHexDetectionTokenUsage,
  type HexDetectionResult,
  type HexDetectionOptions,
  type HexDetectionTokenUsage,
} from "./ai-color-detection";

const DEFAULT_BATCH_API_VERSION = "2025-03-01-preview";
const DEFAULT_BATCH_COMPLETION_WINDOW = "24h";
const REQUEST_TIMEOUT_MS = 30000;

export interface VisionHexBatchRequest {
  customId: string;
  imageUrlOrDataUri: string;
  vendorContext?: HexDetectionOptions["vendorContext"];
}

export interface SubmittedVisionHexBatch {
  batchId: string;
  inputFileId: string;
  requestCount: number;
  submittedAt: string;
}

export interface VisionHexBatchStatus {
  id: string;
  status: string;
  outputFileId: string | null;
  errorFileId: string | null;
  requestCounts: {
    total: number;
    completed: number;
    failed: number;
  } | null;
  raw: Record<string, unknown>;
}

export interface VisionHexBatchOutputRow {
  customId: string;
  content: string | null;
  statusCode: number | null;
  error: string | null;
  usage: HexDetectionTokenUsage | null;
}

interface AzureOpenAiBatchConfig {
  endpoint: string;
  apiKey: string;
  deployment: string;
  apiVersion: string;
}

function getBatchConfig(): AzureOpenAiBatchConfig {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT?.trim();
  const apiKey = process.env.AZURE_OPENAI_KEY?.trim();
  const deployment =
    process.env.AZURE_OPENAI_DEPLOYMENT_HEX_BATCH?.trim() ||
    process.env.AZURE_OPENAI_DEPLOYMENT_HEX?.trim() ||
    process.env.AZURE_OPENAI_DEPLOYMENT?.trim();
  const apiVersion =
    process.env.AZURE_OPENAI_BATCH_API_VERSION?.trim() || DEFAULT_BATCH_API_VERSION;

  if (!endpoint || !apiKey || !deployment) {
    throw new Error(
      "Azure OpenAI batch configuration is incomplete (AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_KEY, AZURE_OPENAI_DEPLOYMENT_HEX_BATCH|AZURE_OPENAI_DEPLOYMENT_HEX|AZURE_OPENAI_DEPLOYMENT)"
    );
  }

  return {
    endpoint: endpoint.replace(/\/+$/, ""),
    apiKey,
    deployment,
    apiVersion,
  };
}

function parseErrorBody(bodyText: string): string {
  if (!bodyText) {
    return "(empty response body)";
  }

  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>;
    const error = parsed.error;
    if (error && typeof error === "object") {
      const row = error as Record<string, unknown>;
      const message = typeof row.message === "string" ? row.message : null;
      const code = typeof row.code === "string" ? row.code : null;
      if (message && code) {
        return `${code}: ${message}`;
      }
      if (message) {
        return message;
      }
    }
  } catch {
    // Fall back to plain text below.
  }

  return bodyText.length > 500 ? `${bodyText.slice(0, 500)}…` : bodyText;
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

async function parseBatchApiResponse<T>(response: Response, action: string): Promise<T> {
  const bodyText = await response.text();

  if (!response.ok) {
    throw new Error(
      `Azure OpenAI batch ${action} failed (${response.status}): ${parseErrorBody(bodyText)}`
    );
  }

  try {
    return JSON.parse(bodyText) as T;
  } catch (error) {
    throw new Error(
      `Azure OpenAI batch ${action} returned invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

function toJsonlLine(request: VisionHexBatchRequest, deployment: string): string {
  const body = {
    model: deployment,
    ...buildHexDetectionRequestPayload(
      request.imageUrlOrDataUri,
      { vendorContext: request.vendorContext },
      false
    ),
  };

  return JSON.stringify({
    custom_id: request.customId,
    method: "POST",
    url: "/chat/completions",
    body,
  });
}

export async function submitVisionHexBatch(
  requests: VisionHexBatchRequest[]
): Promise<SubmittedVisionHexBatch> {
  if (!requests.length) {
    throw new Error("submitVisionHexBatch requires at least one request");
  }

  const cfg = getBatchConfig();
  const jsonl = `${requests.map((request) => toJsonlLine(request, cfg.deployment)).join("\n")}\n`;

  const uploadUrl = `${cfg.endpoint}/openai/files?api-version=${cfg.apiVersion}`;
  const form = new FormData();
  form.append("purpose", "batch");
  form.append(
    "file",
    new Blob([jsonl], { type: "application/jsonl" }),
    `hex-detection-${Date.now()}.jsonl`
  );

  const uploadResponse = await fetchWithTimeout(uploadUrl, {
    method: "POST",
    headers: {
      "api-key": cfg.apiKey,
    },
    body: form,
  });

  const uploadBody = await parseBatchApiResponse<{ id?: string }>(
    uploadResponse,
    "file upload"
  );
  const inputFileId = typeof uploadBody.id === "string" ? uploadBody.id : null;
  if (!inputFileId) {
    throw new Error("Azure OpenAI batch file upload response missing file id");
  }

  const createUrl = `${cfg.endpoint}/openai/batches?api-version=${cfg.apiVersion}`;
  const createResponse = await fetchWithTimeout(createUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": cfg.apiKey,
    },
    body: JSON.stringify({
      input_file_id: inputFileId,
      endpoint: "/chat/completions",
      completion_window:
        process.env.AZURE_OPENAI_BATCH_COMPLETION_WINDOW?.trim() ||
        DEFAULT_BATCH_COMPLETION_WINDOW,
      metadata: {
        purpose: "swatchwatch_hex_detection",
        request_count: String(requests.length),
      },
    }),
  });

  const createBody = await parseBatchApiResponse<{ id?: string }>(
    createResponse,
    "creation"
  );
  const batchId = typeof createBody.id === "string" ? createBody.id : null;
  if (!batchId) {
    throw new Error("Azure OpenAI batch create response missing batch id");
  }

  return {
    batchId,
    inputFileId,
    requestCount: requests.length,
    submittedAt: new Date().toISOString(),
  };
}

export async function getVisionHexBatchStatus(
  batchId: string
): Promise<VisionHexBatchStatus> {
  if (!batchId || !batchId.trim()) {
    throw new Error("Batch id is required");
  }

  const cfg = getBatchConfig();
  const response = await fetchWithTimeout(
    `${cfg.endpoint}/openai/batches/${encodeURIComponent(batchId)}?api-version=${cfg.apiVersion}`,
    {
      method: "GET",
      headers: {
        "api-key": cfg.apiKey,
      },
    }
  );

  const body = await parseBatchApiResponse<Record<string, unknown>>(
    response,
    "status lookup"
  );

  const requestCountsRaw =
    body.request_counts && typeof body.request_counts === "object"
      ? (body.request_counts as Record<string, unknown>)
      : null;

  const requestCounts = requestCountsRaw
    ? {
        total: Number(requestCountsRaw.total || 0),
        completed: Number(requestCountsRaw.completed || 0),
        failed: Number(requestCountsRaw.failed || 0),
      }
    : null;

  return {
    id: typeof body.id === "string" ? body.id : batchId,
    status: typeof body.status === "string" ? body.status : "unknown",
    outputFileId: typeof body.output_file_id === "string" ? body.output_file_id : null,
    errorFileId: typeof body.error_file_id === "string" ? body.error_file_id : null,
    requestCounts,
    raw: body,
  };
}

export async function downloadBatchFileContent(fileId: string): Promise<string> {
  if (!fileId || !fileId.trim()) {
    throw new Error("Batch file id is required");
  }

  const cfg = getBatchConfig();
  const response = await fetchWithTimeout(
    `${cfg.endpoint}/openai/files/${encodeURIComponent(fileId)}/content?api-version=${cfg.apiVersion}`,
    {
      method: "GET",
      headers: {
        "api-key": cfg.apiKey,
      },
    }
  );

  if (!response.ok) {
    const details = parseErrorBody(await response.text());
    throw new Error(
      `Azure OpenAI batch file download failed (${response.status}): ${details}`
    );
  }

  return response.text();
}

function parseJsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseOutputBodyContent(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const row = value as Record<string, unknown>;
  const choices = Array.isArray(row.choices) ? row.choices : [];
  const first = choices[0];
  if (!first || typeof first !== "object") {
    return null;
  }

  const message = (first as Record<string, unknown>).message;
  if (!message || typeof message !== "object") {
    return null;
  }

  const content = (message as Record<string, unknown>).content;
  return typeof content === "string" ? content : null;
}

function parseErrorMessage(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const row = value as Record<string, unknown>;
  if (typeof row.message === "string" && row.message.trim()) {
    return row.message.trim();
  }
  if (typeof row.code === "string" && row.code.trim()) {
    return row.code.trim();
  }
  return null;
}

export function parseVisionHexBatchOutput(
  jsonl: string
): VisionHexBatchOutputRow[] {
  const rows: VisionHexBatchOutputRow[] = [];

  for (const rawLine of jsonl.split(/\r?\n/)) {
    const parsed = parseJsonLine(rawLine);
    if (!parsed) {
      continue;
    }

    const customId =
      typeof parsed.custom_id === "string" && parsed.custom_id.trim().length > 0
        ? parsed.custom_id.trim()
        : null;
    if (!customId) {
      continue;
    }

    const response =
      parsed.response && typeof parsed.response === "object"
        ? (parsed.response as Record<string, unknown>)
        : null;
    const error =
      parsed.error && typeof parsed.error === "object"
        ? (parsed.error as Record<string, unknown>)
        : null;

    const statusCode =
      response && typeof response.status_code === "number"
        ? response.status_code
        : null;
    const responseBody = response?.body;
    const responseUsage =
      responseBody && typeof responseBody === "object"
        ? parseHexDetectionTokenUsage(
            (responseBody as Record<string, unknown>).usage
          )
        : null;

    rows.push({
      customId,
      statusCode,
      content: parseOutputBodyContent(responseBody),
      error: parseErrorMessage(error) || parseErrorMessage(responseBody),
      usage: responseUsage,
    });
  }

  return rows;
}

export async function parseVisionHexBatchDetections(
  rows: VisionHexBatchOutputRow[]
): Promise<
  Array<{
    customId: string;
    detection: HexDetectionResult | null;
    error: string | null;
    usage: HexDetectionTokenUsage | null;
  }>
> {
  const detections: Array<{
    customId: string;
    detection: HexDetectionResult | null;
    error: string | null;
    usage: HexDetectionTokenUsage | null;
  }> = [];

  for (const row of rows) {
    if (row.content) {
      const detection = await parseHexDetectionContent(
        row.content,
        `batch:${row.customId}`,
        undefined,
        row.usage
      );
      detections.push({
        customId: row.customId,
        detection,
        error: row.error,
        usage: row.usage,
      });
      continue;
    }

    detections.push({
      customId: row.customId,
      detection: null,
      error: row.error || "Missing completion content",
      usage: row.usage,
    });
  }

  return detections;
}
