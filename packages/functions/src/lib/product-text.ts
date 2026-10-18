/**
 * Product description text and descriptors kept from ingestion (#352).
 *
 * Every connector stores two extra fields in `external_product.normalized_json`:
 * - `descriptionText`: the vendor's product description as plain text (HTML stripped, entities
 *   decoded, whitespace collapsed, capped at `PRODUCT_DESCRIPTION_MAX_CHARS`), or `null`.
 * - `descriptors`: short structured strings about the product (product type, variant option
 *   names and values, every tag, collection names), trimmed, de-duplicated case-insensitively
 *   (first spelling kept) and capped at `PRODUCT_DESCRIPTORS_MAX` entries.
 *
 * They feed finish detection (`lib/finish-text.ts`, the vision prompt in
 * `ai-color-detection.ts`). They live only in `normalized_json` (no `shade` column) and are
 * reached from a shade through `shade_source_product`; they are never returned by user-facing
 * API responses. `npm run backfill:product-text` recomputes them from `raw_json` with the same
 * helpers, so connectors and the backfill cannot drift apart.
 */

/** Longest `descriptionText` stored in `normalized_json` (characters, ellipsis included). */
export const PRODUCT_DESCRIPTION_MAX_CHARS = 2000;
/** Most `descriptors` stored per product. */
export const PRODUCT_DESCRIPTORS_MAX = 60;
/** Longest single descriptor (characters); longer values are truncated. */
export const PRODUCT_DESCRIPTOR_MAX_CHARS = 120;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  rsquo: "'",
  lsquo: "'",
  rdquo: '"',
  ldquo: '"',
  ndash: "-",
  mdash: "-",
  hellip: "…",
  trade: "™",
  reg: "®",
  copy: "©",
  deg: "°",
  times: "×",
  bull: "•",
  middot: "·",
  eacute: "é",
  egrave: "è",
  agrave: "à",
  ccedil: "ç",
};

function decodeEntity(entity: string, body: string): string {
  if (body.startsWith("#")) {
    const isHex = body[1] === "x" || body[1] === "X";
    const codePoint = Number.parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10);
    if (Number.isFinite(codePoint) && codePoint > 0 && codePoint <= 0x10ffff) {
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return " ";
      }
    }
    return " ";
  }
  return NAMED_ENTITIES[body.toLowerCase()] ?? entity;
}

/** Cut `text` to at most `maxChars` characters (ellipsis included), preferring a word boundary. */
export function truncateText(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  const room = Math.max(0, maxChars - 1);
  let cut = text.slice(0, room);
  const lastSpace = cut.lastIndexOf(" ");
  // Only back off to a word boundary when it costs little of the budget.
  if (lastSpace > 0 && room - lastSpace <= 30) {
    cut = cut.slice(0, lastSpace);
  }
  return `${cut.trimEnd()}…`;
}

export interface HtmlToPlainTextOptions {
  /**
   * When true (the default), the end of a block element (`</p>`, `</li>`, `<br>`, ...) ends a
   * sentence: a ". " is inserted unless the block already ended with sentence punctuation. This
   * keeps list items such as "Pairs well with X" from running into the next item, which the
   * finish text parser relies on (it cuts cross-sell clauses at the sentence end). When false,
   * block ends become plain spaces.
   */
  sentenceBreaks?: boolean;
}

const BLOCK_END = "\u0000";

/**
 * HTML (or plain text) → one line of plain text: `<script>`/`<style>` bodies and comments
 * dropped, tags removed, named and numeric entities decoded, whitespace collapsed, then capped at
 * `maxChars`. Returns `null` for empty or non-string input.
 */
export function htmlToPlainText(
  html: unknown,
  maxChars: number = PRODUCT_DESCRIPTION_MAX_CHARS,
  options: HtmlToPlainTextOptions = {}
): string | null {
  if (typeof html !== "string" || !html) return null;
  const sentenceBreaks = options.sentenceBreaks !== false;
  let text = html
    .replace(/<\s*(script|style)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/td)\s*\/?>/gi, sentenceBreaks ? BLOCK_END : " ")
    .replace(/<[^>]*>/g, " ");
  text = text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (entity, body: string) => decodeEntity(entity, body));
  text = text.replace(/\s+/g, " ");
  if (sentenceBreaks) {
    // Each run of block ends becomes one sentence break, unless the text before it already ends
    // a sentence (or there is no text before it).
    text = text.replace(/(\S?)((?:\s*\u0000)+\s*)/g, (_match, before: string) => {
      if (!before) return " ";
      return /[.!?:;]/.test(before) ? `${before} ` : `${before}. `;
    });
  }
  // Removing inline tags ("<b>jelly</b>.") leaves a space before punctuation; drop it.
  text = text.replace(/\s+/g, " ").replace(/ ([.,!?;:])(?=\s|$)/g, "$1").trim();
  if (!text) return null;
  return truncateText(text, maxChars);
}

/** Shopify's placeholder option name/value for single-variant products. */
const PLACEHOLDER_DESCRIPTORS: ReadonlySet<string> = new Set(["title", "default title", "default"]);
const HEX_ONLY = /^#?[0-9a-f]{6}$/i;

/**
 * Normalize a descriptor list: strings (and numbers) only, whitespace collapsed, trimmed,
 * truncated to `PRODUCT_DESCRIPTOR_MAX_CHARS`, Shopify placeholders ("Default Title") and bare
 * hex codes dropped, de-duplicated case-insensitively (first spelling and order kept), and
 * capped at `max` entries.
 */
export function normalizeDescriptors(
  values: Iterable<unknown> | null | undefined,
  max: number = PRODUCT_DESCRIPTORS_MAX
): string[] {
  const out: string[] = [];
  if (!values) return out;
  const seen = new Set<string>();
  for (const value of values) {
    if (out.length >= max) break;
    const raw = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
    if (typeof raw !== "string") continue;
    const collapsed = raw.replace(/\s+/g, " ").trim();
    if (!collapsed) continue;
    const text = truncateText(collapsed, PRODUCT_DESCRIPTOR_MAX_CHARS);
    const key = text.toLowerCase();
    if (PLACEHOLDER_DESCRIPTORS.has(key) || HEX_ONLY.test(text) || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

export interface ProductText {
  descriptionText: string | null;
  descriptors: string[];
}

function stringList(value: unknown): string[] {
  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function prefixedValues(tags: readonly string[], prefix: string): string[] {
  const lower = prefix.toLowerCase();
  return tags
    .filter((tag) => tag.trim().toLowerCase().startsWith(lower))
    .map((tag) => tag.trim().slice(prefix.length).trim())
    .filter(Boolean);
}

/**
 * Product text from a raw Shopify `products.json` product (used by the generic Shopify and
 * Holo Taco connectors): `body_html` → `descriptionText`; descriptors are the product type,
 * each `options[].name` and its values, each variant's option values, every tag, and the
 * `collection:` tag values without their prefix.
 */
export function shopifyProductText(product: Record<string, unknown> | null | undefined): ProductText {
  if (!product || typeof product !== "object") return { descriptionText: null, descriptors: [] };

  const descriptors: unknown[] = [product.product_type];
  if (Array.isArray(product.options)) {
    for (const option of product.options) {
      if (!option || typeof option !== "object") continue;
      const row = option as Record<string, unknown>;
      descriptors.push(row.name, ...stringList(row.values));
    }
  }
  if (Array.isArray(product.variants)) {
    for (const variant of product.variants) {
      if (!variant || typeof variant !== "object") continue;
      const row = variant as Record<string, unknown>;
      descriptors.push(row.option1, row.option2, row.option3);
    }
  }
  const tags = stringList(product.tags);
  descriptors.push(...tags, ...prefixedValues(tags, "collection:"));

  return {
    descriptionText: htmlToPlainText(product.body_html),
    descriptors: normalizeDescriptors(descriptors),
  };
}

/**
 * Product text from a raw MakeupAPI product: `description` → `descriptionText`; descriptors are
 * `product_type`, `category` and `tag_list`. Per-variant colour names are left out on purpose:
 * finishes resolved from descriptors apply to every variant of the product.
 */
export function makeupApiProductText(product: Record<string, unknown> | null | undefined): ProductText {
  if (!product || typeof product !== "object") return { descriptionText: null, descriptors: [] };
  return {
    descriptionText: htmlToPlainText(product.description),
    descriptors: normalizeDescriptors([product.product_type, product.category, ...stringList(product.tag_list)]),
  };
}

/** `en:nail-polishes` → `nail polishes` (OpenBeautyFacts taxonomy tags). */
function openBeautyFactsTagText(tag: string): string {
  return tag.replace(/^[a-z]{2,3}:/i, "").replace(/[-_]+/g, " ");
}

/**
 * Product text from a raw OpenBeautyFacts product. OBF has no marketing description, so
 * `descriptionText` is the generic name (`generic_name`, else the first `generic_name_<lang>`)
 * when it differs from the product name; descriptors are the `categories_tags` and `labels_tags`
 * taxonomy values without their language prefix.
 */
export function openBeautyFactsProductText(product: Record<string, unknown> | null | undefined): ProductText {
  if (!product || typeof product !== "object") return { descriptionText: null, descriptors: [] };

  let generic: unknown = product.generic_name;
  if (typeof generic !== "string" || !generic.trim()) {
    const localized = Object.keys(product)
      .filter((key) => /^generic_name_[a-z]{2,3}$/.test(key))
      .sort()
      .map((key) => product[key])
      .find((value) => typeof value === "string" && value.trim());
    generic = localized ?? null;
  }
  let descriptionText = htmlToPlainText(generic);
  const name = typeof product.product_name === "string" ? product.product_name.trim().toLowerCase() : null;
  if (descriptionText && name && descriptionText.toLowerCase() === name) {
    descriptionText = null;
  }

  return {
    descriptionText,
    descriptors: normalizeDescriptors(
      [...stringList(product.categories_tags), ...stringList(product.labels_tags)].map(openBeautyFactsTagText)
    ),
  };
}

/**
 * Product text for a raw connector payload by data source name (the same extractor the
 * connector uses): `OpenBeautyFacts`, `MakeupAPI`, or any `*Shopify` source. Returns `null` for
 * an unknown source so callers leave its rows alone.
 */
export function productTextFromRaw(sourceName: string, raw: unknown): ProductText | null {
  const product = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (sourceName === "OpenBeautyFacts") return openBeautyFactsProductText(product);
  if (sourceName === "MakeupAPI") return makeupApiProductText(product);
  if (sourceName.endsWith("Shopify")) return shopifyProductText(product);
  return null;
}

/**
 * Read the stored product text back from a `normalized_json` object (connector record or DB
 * row). Missing or malformed fields read as `null` / `[]`.
 */
export function readProductText(normalized: Record<string, unknown> | null | undefined): ProductText {
  if (!normalized || typeof normalized !== "object") return { descriptionText: null, descriptors: [] };
  const description = normalized.descriptionText;
  return {
    descriptionText: typeof description === "string" && description.trim() ? description.trim() : null,
    descriptors: normalizeDescriptors(Array.isArray(normalized.descriptors) ? normalized.descriptors : []),
  };
}
