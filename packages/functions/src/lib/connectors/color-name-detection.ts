/**
 * Color Name to Hex Detection
 * 
 * Uses Azure OpenAI to map color names to hex values when hex is not
 * available in the product data.
 */

const OPENAI_API_VERSION = "2024-05-01-preview";
const REQUEST_TIMEOUT_MS = 15000;

// Common color name to hex mappings (fallback)
const COMMON_COLORS: Record<string, string> = {
  // Reds
  red: "#FF0000",
  crimson: "#DC143C",
  burgundy: "#800020",
  maroon: "#800000",
  scarlet: "#FF2400",
  ruby: "#E0115F",
  cherry: "#FF006E",
  
  // Pinks
  pink: "#FFC0CB",
  "hot pink": "#FF69B4",
  "deep pink": "#FF1493",
  "light pink": "#FFB6C1",
  bubblegum: "#FF85A2",
  rose: "#FF007F",
  
  // Purples
  purple: "#800080",
  violet: "#EE82EE",
  lavender: "#E6E6FA",
  indigo: "#4B0082",
  plum: "#DDA0DD",
  lilac: "#C8A2C8",
  orchid: "#DA70D6",
  
  // Blues
  blue: "#0000FF",
  "royal blue": "#4169E1",
  navy: "#000080",
  "dark blue": "#00008B",
  "sky blue": "#87CEEB",
  "light blue": "#ADD8E6",
  cobalt: "#0047AB",
  turquoise: "#40E0D0",
  teal: "#008080",
  cyan: "#00FFFF",
  aqua: "#00FFFF",
  
  // Greens
  green: "#008000",
  "dark green": "#006400",
  "light green": "#90EE90",
  lime: "#00FF00",
  emerald: "#50C878",
  mint: "#98FF98",
  sage: "#9DC183",
  olive: "#808000",
  forest: "#228B22",
  
  // Yellows/Oranges
  yellow: "#FFFF00",
  gold: "#FFD700",
  "golden": "#FFD700",
  orange: "#FFA500",
  "dark orange": "#FF8C00",
  tangerine: "#FF9966",
  coral: "#FF7F50",
  peach: "#FFCBA4",
  cream: "#FFFDD0",
  beige: "#F5F5DC",
  caramel: "#C68E17",
  
  // Browns
  brown: "#A52A2A",
  chocolate: "#7B3F00",
  coffee: "#6F4E37",
  bronze: "#CD7F32",
  rust: "#B7410E",
  cinnamon: "#D2691E",
  
  // Grays/Blacks/Whites
  black: "#000000",
  white: "#FFFFFF",
  silver: "#C0C0C0",
  gray: "#808080",
  grey: "#808080",
  charcoal: "#36454F",
  slate: "#708090",
  ivory: "#FFFFF0",
  "off white": "#FAF9F6",
  
  // Neutrals
  nude: "#E3BC9A",
  taupe: "#483C32",
  champagne: "#F7E7CE",
  sandstone: "#C2B280",
};

// Special finishes that don't have a single hex color
const SPECIAL_FINISHES = new Set([
  "holographic", "holo", "shimmer", "glitter", "chrome", 
  "metallic", "iridescent", "duochrome", "multichrome", 
  "thermal", "magnetic"
]);

export interface ColorNameDetectionResult {
  hex: string | null;
  confidence: number | null;
  provider: "builtin" | "azure-openai" | "none";
}

export interface DetectHexOptions {
  /** When true, always prefer AI over builtin lookup for better accuracy */
  preferAi?: boolean;
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

/**
 * Detect hex from color name using Azure OpenAI
 */
async function detectWithAzureOpenAI(colorName: string): Promise<ColorNameDetectionResult> {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT?.trim();
  const apiKey = process.env.AZURE_OPENAI_KEY?.trim();
  const deployment =
    process.env.AZURE_OPENAI_DEPLOYMENT_HEX?.trim() ||
    process.env.AZURE_OPENAI_DEPLOYMENT?.trim();

  if (!endpoint || !apiKey || !deployment) {
    return { hex: null, confidence: null, provider: "none" };
  }

  const requestUrl = `${endpoint.replace(/\/+$/, "")}/openai/deployments/${deployment}/chat/completions?api-version=${OPENAI_API_VERSION}`;

  try {
    const response = await fetchWithTimeout(requestUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": apiKey,
      },
      body: JSON.stringify({
        temperature: 0,
        max_tokens: 60,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You map a nail polish color name to a hex color code. Return valid JSON with hex (format: #RRGGBB) and confidence (0-1). Only respond with the JSON, nothing else.",
          },
          {
            role: "user",
            content: `Color name: "${colorName}". What is the hex color?`,
          },
        ],
      }),
    });

    if (!response.ok) {
      console.log(`[color-name-detection] Azure OpenAI failed: ${response.status}`);
      return { hex: null, confidence: null, provider: "none" };
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

    // Parse the JSON response
    const parsed = JSON.parse(content) as Record<string, unknown>;
    let hex: string | null = null;

    if (typeof parsed.hex === "string") {
      const match = parsed.hex.match(/^#?([0-9A-Fa-f]{6})$/);
      if (match) {
        hex = `#${match[1].toUpperCase()}`;
      }
    }

    let confidence: number | null = null;
    if (typeof parsed.confidence === "number") {
      confidence = Math.max(0, Math.min(1, parsed.confidence));
    }

    return { hex, confidence, provider: "azure-openai" };
  } catch (error) {
    console.log(`[color-name-detection] Azure OpenAI error: ${error instanceof Error ? error.message : String(error)}`);
    return { hex: null, confidence: null, provider: "none" };
  }
}

/**
 * Main function to detect hex from color name
 * Uses AI or built-in lookup depending on options
 */
export async function detectHexFromColorName(
  colorName: string,
  options?: DetectHexOptions
): Promise<ColorNameDetectionResult> {
  if (!colorName || typeof colorName !== "string") {
    return { hex: null, confidence: null, provider: "none" };
  }

  const normalizedName = colorName.toLowerCase().trim();

  // Check if it's a special finish (no single hex color)
  if (SPECIAL_FINISHES.has(normalizedName)) {
    return { hex: null, confidence: null, provider: "builtin" };
  }

  // If preferAi is true, skip builtin and go straight to AI for better accuracy
  if (options?.preferAi) {
    const aiResult = await detectWithAzureOpenAI(colorName);
    if (aiResult.hex) {
      return { ...aiResult, confidence: aiResult.confidence ?? 0.5 };
    }
    // If AI fails, fall back to builtin
  }

  // Check built-in common colors
  if (normalizedName in COMMON_COLORS) {
    const hex = COMMON_COLORS[normalizedName];
    return { hex, confidence: 0.95, provider: "builtin" };
  }

  // Try partial match
  for (const [name, hex] of Object.entries(COMMON_COLORS)) {
    if (normalizedName.includes(name) || name.includes(normalizedName)) {
      return { hex, confidence: 0.7, provider: "builtin" };
    }
  }

  // Fallback to Azure OpenAI for unknown color names
  const aiResult = await detectWithAzureOpenAI(colorName);
  if (aiResult.hex) {
    return { ...aiResult, confidence: aiResult.confidence ?? 0.5 };
  }

  return { hex: null, confidence: null, provider: "none" };
}
