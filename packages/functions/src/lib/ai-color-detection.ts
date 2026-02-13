const OPENAI_API_VERSION = "2024-10-21";
const REQUEST_TIMEOUT_MS = 20000;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 2000;
const RATE_LIMIT_DELAY_MS = 10000;

export interface HexDetectionResult {
  hex: string | null;
  confidence: number | null;
  provider: "azure-openai" | "none";
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

function parseHexFromContent(content: string): HexDetectionResult {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const hex = normalizeHex(parsed.hex);
    const confidence = parseConfidence(parsed.confidence);
    if (hex) {
      return { hex, confidence, provider: "azure-openai" };
    }
  } catch {
    // Fall through to regex extraction.
  }

  const fallbackMatch = content.match(/#?[0-9a-fA-F]{6}/);
  const hex = normalizeHex(fallbackMatch?.[0]);
  return {
    hex,
    confidence: null,
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

async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetchWithTimeout(url, init);

      if (response.status === 429) {
        const retryAfter = parseRetryAfter(response) || RATE_LIMIT_DELAY_MS;
        const delay = Math.min(retryAfter, 60000);
        await sleep(delay);
        continue;
      }

      if (response.status >= 500 && attempt < MAX_RETRIES - 1) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        await sleep(delay);
        continue;
      }

      return response;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < MAX_RETRIES - 1) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        await sleep(delay);
      }
    }
  }

  throw lastError || new Error("Request failed after retries");
}

export async function detectHexWithAzureOpenAI(imageUrl: string): Promise<HexDetectionResult> {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT?.trim();
  const apiKey = process.env.AZURE_OPENAI_KEY?.trim();
  const deployment =
    process.env.AZURE_OPENAI_DEPLOYMENT_HEX?.trim() ||
    process.env.AZURE_OPENAI_DEPLOYMENT?.trim();

  if (!endpoint || !apiKey || !deployment) {
    return { hex: null, confidence: null, provider: "none" };
  }

  const requestUrl = `${endpoint.replace(/\/+$/, "")}/openai/deployments/${deployment}/chat/completions?api-version=${OPENAI_API_VERSION}`;
  const response = await fetchWithRetry(requestUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": apiKey,
    },
    body: JSON.stringify({
      temperature: 0,
      max_tokens: 120,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You extract one representative BASE polish color from a nail polish product image. Ignore background, props, packaging/box, labels/text, bottle cap, nail brush, skin tones, and glare. For glitter/shimmer/holo finishes, infer the underlying base lacquer color, not reflective particles. Respond as strict JSON only: {\"hex\":\"#RRGGBB\"|null,\"confidence\":0..1}.",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "Image may show either a bottle product shot or closeup painted nails. Return exactly one hex for the primary marketed base shade. Exclude background, brush, cap, box, and sparkle highlights. If unusable, return null hex with low confidence.",
            },
            {
              type: "image_url",
              image_url: { url: imageUrl },
            },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const details = await response.text().catch(() => "");
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

  return parseHexFromContent(content);
}
