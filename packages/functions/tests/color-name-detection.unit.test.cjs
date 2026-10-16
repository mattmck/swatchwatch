const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  buildColorNamePrompt,
  stripHtmlToText,
  detectHexFromColorName,
  COMMON_COLORS,
  COLOR_NAME_DESCRIPTION_MAX_CHARS,
} = require("../dist/lib/connectors/color-name-detection");

const AZURE_ENV_KEYS = [
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_OPENAI_KEY",
  "AZURE_OPENAI_DEPLOYMENT_HEX",
  "AZURE_OPENAI_DEPLOYMENT",
  "AZURE_OPENAI_USE_GATEWAY",
  "AZURE_OPENAI_GATEWAY_ENDPOINT",
  "AZURE_OPENAI_GATEWAY_SUBSCRIPTION_KEY",
];

describe("lib/connectors/color-name-detection — buildColorNamePrompt", () => {
  it("builds the original context-free prompt when no context is given", () => {
    const prompt = buildColorNamePrompt("Wildberry");
    assert.equal(prompt.user, 'Color name: "Wildberry". What is the hex color?');
    assert.match(prompt.system, /Return valid JSON with hex \(format: #RRGGBB\) and confidence \(0-1\)/);
    assert.doesNotMatch(prompt.system, /brand/i);
  });

  it("treats an all-empty context like no context", () => {
    const prompt = buildColorNamePrompt("Wildberry", { brand: "  ", tags: [], description: null, finishes: [] });
    assert.equal(prompt.user, 'Color name: "Wildberry". What is the hex color?');
  });

  it("builds the brand-aware prompt in a stable order", () => {
    const prompt = buildColorNamePrompt("Wildberry", {
      brand: "Mooncat",
      productLine: "Nail Lacquer",
      collection: "Hallows' Eve",
      description: "A deep berry creme with a hidden blue flash.",
      tags: ["color:purple", "finish:creme", "collection:Hallows' Eve"],
      finishes: ["creme"],
    });

    assert.equal(
      prompt.user,
      "Brand: Mooncat. Product line: Nail Lacquer. Collection: Hallows' Eve. " +
        'Shade name: "Wildberry". Finish: creme. ' +
        "Tags: color:purple, finish:creme, collection:Hallows' Eve. " +
        "Description: A deep berry creme with a hidden blue flash. " +
        "What is the hex color of this shade?"
    );
  });

  it("tells the model to use brand knowledge and to lower confidence when it lacks it", () => {
    const prompt = buildColorNamePrompt("Wildberry", { brand: "Mooncat" });
    assert.match(prompt.system, /knowledge of that brand's actual shade/);
    assert.match(prompt.system, /confidence 0\.7 or higher/);
    assert.match(prompt.system, /do not know that specific product/);
    assert.match(prompt.system, /confidence 0\.5 or lower/);
    assert.match(prompt.system, /Return valid JSON with hex \(format: #RRGGBB\) and confidence \(0-1\)/);
  });

  it("skips empty fields and only includes what is present", () => {
    const prompt = buildColorNamePrompt("Wildberry", { brand: "Mooncat", collection: null, tags: null });
    assert.equal(prompt.user, 'Brand: Mooncat. Shade name: "Wildberry". What is the hex color of this shade?');
  });

  it("de-duplicates tags case-insensitively and caps the list", () => {
    const tags = ["Creme", "creme", ...Array.from({ length: 30 }, (_, i) => `tag${i}`)];
    const prompt = buildColorNamePrompt("Wildberry", { tags });
    const match = prompt.user.match(/Tags: ([^.]+)\./);
    assert.ok(match, prompt.user);
    const listed = match[1].split(", ");
    assert.equal(listed[0], "Creme");
    assert.equal(listed.includes("creme"), false);
    assert.equal(listed.length, 20);
  });

  it("collapses whitespace in the shade name and fields", () => {
    const prompt = buildColorNamePrompt("  Wild   berry ", { brand: "Moon\ncat" });
    assert.equal(prompt.user, 'Brand: Moon cat. Shade name: "Wild berry". What is the hex color of this shade?');
  });
});

describe("lib/connectors/color-name-detection — stripHtmlToText", () => {
  it("returns null for empty input", () => {
    assert.equal(stripHtmlToText(null), null);
    assert.equal(stripHtmlToText(""), null);
    assert.equal(stripHtmlToText("<p></p>"), null);
  });

  it("drops tags, decodes entities and collapses whitespace", () => {
    const text = stripHtmlToText(
      "<p>A <strong>deep</strong> berry&nbsp;creme.</p><ul><li>2 coats</li><li>Vegan &amp; cruelty-free</li></ul>"
    );
    assert.equal(text, "A deep berry creme. 2 coats Vegan & cruelty-free");
  });

  it("truncates long descriptions with an ellipsis", () => {
    const long = "word ".repeat(200);
    const text = stripHtmlToText(`<p>${long}</p>`);
    assert.ok(text.length <= COLOR_NAME_DESCRIPTION_MAX_CHARS, `length ${text.length}`);
    assert.ok(text.endsWith("…"));

    const custom = stripHtmlToText(`<p>${long}</p>`, 50);
    assert.ok(custom.length <= 50);
    assert.ok(custom.endsWith("…"));
  });

  it("does not truncate short descriptions", () => {
    assert.equal(stripHtmlToText("<div>Short</div>"), "Short");
  });
});

describe("lib/connectors/color-name-detection — detectHexFromColorName backward compatibility (no network)", () => {
  const saved = {};

  beforeEach(() => {
    for (const key of AZURE_ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of AZURE_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("exports the builtin palette used by suspicious-hex", () => {
    assert.equal(COMMON_COLORS["hot pink"], "#FF69B4");
    assert.equal(COMMON_COLORS.lilac, "#C8A2C8");
  });

  it("returns the builtin hex for an exact common color without context", async () => {
    const result = await detectHexFromColorName("hot pink");
    assert.deepEqual(result, { hex: "#FF69B4", confidence: 0.95, provider: "builtin" });
  });

  it("returns a partial builtin match with lower confidence", async () => {
    const result = await detectHexFromColorName("dusty rose");
    assert.equal(result.provider, "builtin");
    assert.equal(result.confidence, 0.7);
    assert.equal(result.hex, COMMON_COLORS.rose);
  });

  it("returns builtin with no hex for special finishes", async () => {
    const result = await detectHexFromColorName("holographic");
    assert.deepEqual(result, { hex: null, confidence: null, provider: "builtin" });
  });

  it("returns none for an unknown name when Azure OpenAI is not configured", async () => {
    const result = await detectHexFromColorName("Midnight Garden");
    assert.deepEqual(result, { hex: null, confidence: null, provider: "none" });
  });

  it("rejects non-string input", async () => {
    assert.deepEqual(await detectHexFromColorName(""), { hex: null, confidence: null, provider: "none" });
    assert.deepEqual(await detectHexFromColorName(null), { hex: null, confidence: null, provider: "none" });
  });

  it("falls back to builtin when preferAi is set but Azure OpenAI is not configured", async () => {
    const result = await detectHexFromColorName("hot pink", { preferAi: true });
    assert.deepEqual(result, { hex: "#FF69B4", confidence: 0.95, provider: "builtin" });
  });

  it("accepts a context without changing the builtin result shape", async () => {
    const result = await detectHexFromColorName("hot pink", {
      preferAi: true,
      context: { brand: "Mooncat", collection: "Summer", tags: ["finish:creme"] },
    });
    assert.deepEqual(result, { hex: "#FF69B4", confidence: 0.95, provider: "builtin" });
  });
});
