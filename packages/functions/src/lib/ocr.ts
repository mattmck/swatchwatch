/**
 * Server-side OCR via Azure AI Document Intelligence (prebuilt-read model).
 * Graceful degradation: returns null when credentials are not configured.
 */

const LOG_PREFIX = "[ocr]";
const API_VERSION = "2024-11-30";
const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 30000;
const REQUEST_TIMEOUT_MS = 15000;
const RATE_LIMIT_RETRY_DELAY_MS = 2000;
const MAX_ERROR_BODY_LOG_CHARS = 400;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OcrResult {
  rawText: string;
  lines: OcrLine[];
  barcodes: OcrBarcode[];
  confidence: number;
  provider: string;
}

export interface OcrLine {
  text: string;
  confidence: number;
  boundingBox?: number[];
}

export interface OcrBarcode {
  value: string;
  kind: string;
  confidence: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
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

function buildRequestBody(imageInput: string): { contentType: string; body: string } {
  if (imageInput.startsWith("data:")) {
    // Strip data URI prefix: "data:image/png;base64,<payload>" → "<payload>"
    const commaIndex = imageInput.indexOf(",");
    const base64Payload = commaIndex >= 0 ? imageInput.slice(commaIndex + 1) : imageInput;
    return {
      contentType: "application/json",
      body: JSON.stringify({ base64Source: base64Payload }),
    };
  }

  // Treat as URL
  return {
    contentType: "application/json",
    body: JSON.stringify({ urlSource: imageInput }),
  };
}

// ---------------------------------------------------------------------------
// Polling result types (internal)
// ---------------------------------------------------------------------------

interface AnalyzeResultPage {
  lines?: Array<{
    content?: string;
    confidence?: number;
    polygon?: number[];
  }>;
  barcodes?: Array<{
    value?: string;
    kind?: string;
    confidence?: number;
  }>;
}

interface AnalyzeResultBody {
  status?: string;
  analyzeResult?: {
    content?: string;
    pages?: AnalyzeResultPage[];
  };
  error?: {
    code?: string;
    message?: string;
  };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Extract text, lines, and barcodes from an image using Azure AI Document Intelligence.
 *
 * @param imageInput - An HTTPS URL or a base64 data URI (`data:image/...;base64,...`).
 * @returns Parsed OCR result, or `null` when credentials are missing or an unrecoverable error occurs.
 */
export async function extractTextFromImage(imageInput: string): Promise<OcrResult | null> {
  const endpoint = process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT?.trim();
  const key = process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY?.trim();

  if (!endpoint || !key) {
    console.warn(
      `${LOG_PREFIX} AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT or AZURE_DOCUMENT_INTELLIGENCE_KEY not configured — skipping OCR`
    );
    return null;
  }

  const analyzeUrl = `${endpoint.replace(/\/+$/, "")}/documentintelligence/documentModels/prebuilt-read:analyze?api-version=${API_VERSION}`;
  const { contentType, body } = buildRequestBody(imageInput);

  // ---- Submit analysis request ----
  let submitResponse: Response;
  try {
    submitResponse = await fetchWithTimeout(analyzeUrl, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": key,
        "Content-Type": contentType,
      },
      body,
    });
  } catch (error) {
    console.error(
      `${LOG_PREFIX} Failed to submit analysis request: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }

  // Handle 429 with one retry
  if (submitResponse.status === 429) {
    console.warn(`${LOG_PREFIX} Rate-limited (429), retrying in ${RATE_LIMIT_RETRY_DELAY_MS}ms`);
    await sleep(RATE_LIMIT_RETRY_DELAY_MS);
    try {
      submitResponse = await fetchWithTimeout(analyzeUrl, {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": key,
          "Content-Type": contentType,
        },
        body,
      });
    } catch (error) {
      console.error(
        `${LOG_PREFIX} Retry request failed: ${error instanceof Error ? error.message : String(error)}`
      );
      return null;
    }
  }

  if (!submitResponse.ok) {
    const snippet = await readErrorBodySnippet(submitResponse);
    console.error(
      `${LOG_PREFIX} Analysis request failed: status=${submitResponse.status}, body=${snippet || "n/a"}`
    );
    return null;
  }

  const operationLocation = submitResponse.headers.get("Operation-Location");
  if (!operationLocation) {
    console.error(`${LOG_PREFIX} No Operation-Location header in response`);
    return null;
  }

  // ---- Poll for completion ----
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let result: AnalyzeResultBody | null = null;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);

    let pollResponse: Response;
    try {
      pollResponse = await fetchWithTimeout(operationLocation, {
        method: "GET",
        headers: {
          "Ocp-Apim-Subscription-Key": key,
        },
      });
    } catch (error) {
      console.error(
        `${LOG_PREFIX} Poll request failed: ${error instanceof Error ? error.message : String(error)}`
      );
      return null;
    }

    if (!pollResponse.ok) {
      const snippet = await readErrorBodySnippet(pollResponse);
      console.error(
        `${LOG_PREFIX} Poll returned non-OK: status=${pollResponse.status}, body=${snippet || "n/a"}`
      );
      return null;
    }

    const pollBody = (await pollResponse.json()) as AnalyzeResultBody;

    if (pollBody.status === "succeeded") {
      result = pollBody;
      break;
    }

    if (pollBody.status === "failed") {
      const errorCode = pollBody.error?.code ?? "unknown";
      const errorMessage = String(pollBody.error?.message ?? "n/a").slice(0, MAX_ERROR_BODY_LOG_CHARS);
      console.error(
        `${LOG_PREFIX} Analysis failed: status=failed, errorCode=${errorCode}, errorMessage=${errorMessage}`
      );
      return null;
    }

    // status is "running" or "notStarted" — continue polling
  }

  if (!result) {
    console.error(`${LOG_PREFIX} Polling timed out after ${POLL_TIMEOUT_MS}ms`);
    return null;
  }

  // ---- Parse result ----
  const analyzeResult = result.analyzeResult;
  const rawText = analyzeResult?.content ?? "";

  const lines: OcrLine[] = [];
  const barcodes: OcrBarcode[] = [];
  let confidenceSum = 0;
  let confidenceCount = 0;

  for (const page of analyzeResult?.pages ?? []) {
    for (const line of page.lines ?? []) {
      const lineConfidence = typeof line.confidence === "number" ? line.confidence : 0;
      lines.push({
        text: line.content ?? "",
        confidence: lineConfidence,
        boundingBox: line.polygon,
      });
      confidenceSum += lineConfidence;
      confidenceCount++;
    }

    for (const barcode of page.barcodes ?? []) {
      barcodes.push({
        value: barcode.value ?? "",
        kind: barcode.kind ?? "unknown",
        confidence: typeof barcode.confidence === "number" ? barcode.confidence : 0,
      });
    }
  }

  const confidence = confidenceCount > 0 ? confidenceSum / confidenceCount : 0;

  return {
    rawText,
    lines,
    barcodes,
    confidence,
    provider: "azure-document-intelligence",
  };
}
