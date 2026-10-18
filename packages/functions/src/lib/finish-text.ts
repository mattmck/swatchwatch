/**
 * Finish detection from product descriptors and description text (#352).
 *
 * Ingestion used to read finishes from vendor tags only (`parseFinishesFromTags`). Product
 * descriptions and descriptors (product type, variant options, collection names; see
 * `lib/product-text.ts`) often spell the finish out ("a linear holo with gold shimmer"), so this
 * module matches the runtime finish catalog against that text:
 *
 * - Phrases: every `finish_type` name plus every `finish_normalization` alias that resolves to
 *   one (so admin-created finish types and aliases work), matched case-insensitively as whole
 *   words, with spaces, hyphens and underscores interchangeable and an optional plural `s`/`es`
 *   ("glow-in-the-dark", "holo flakes"). Longer phrases win over the words inside them
 *   ("holo glitter" → `holographic` only, as the alias table says). The `other` catch-all and
 *   phrases under 3 characters are never matched.
 * - Negation: a match is dropped when one of `NEGATION_WORDS` ("no", "not", "without", ...) is
 *   among the 3 words before it in the same clause (clauses end at , ; : . ! ? dashes and
 *   brackets), when "non" comes right before it ("non-holo"), or when "free" follows it
 *   ("shimmer-free", "glitter free").
 * - Other products: in description text, everything from a cross-sell cue ("pairs well with",
 *   "layer it over", "shown over", "try our", "you may also like", ...; `CROSS_SELL_CUES`) to the
 *   end of its sentence is ignored, and a finish word directly followed by "top coat" / "base
 *   coat" is read as the name of another product ("our matte top coat"), not this one's finish.
 * - Ambiguous words: `glow`, `cream`, `creamy` and `sheer` are ordinary English, so they only
 *   count when one of `FINISH_CONTEXT_NOUNS` ("finish", "polish", "formula", ...) follows within
 *   two words ("a creamy pink formula"), or, for descriptors, when the descriptor is that word
 *   alone (a variant option "Glow").
 * - Brand: the product's brand is blanked out first, so "Holo Taco" is not a holo finish.
 * - Descriptors are parsed one by one; namespaced ones (`color:cream`, `collection:holo`) are
 *   skipped except `finish:`, `type:`, `effect:` and `texture:` (collection names are already
 *   present as plain descriptors).
 *
 * Limits (deliberately simple, keyword-level rules): negation is only noticed within 3 words of
 * the same clause ("this is not, despite the name, a shimmer" still yields shimmer); shade or
 * collection names that contain a finish word ("Creme Brûlée", "Glitter Bomb") are read as
 * finishes; a cross-sell sentence without one of the listed cues is read as describing this
 * product; and a finish mentioned as a comparison ("more sparkle than a shimmer") counts.
 * That is why description-text matches are the lowest-precedence source (see
 * `resolveProductFinishes`) and only ever fill empty finishes (`applyIngestedFinishes`).
 *
 * Pure: pass `await loadFinishCatalog()` to honor admin-managed finish types and aliases;
 * defaults to the built-in catalog.
 */
import {
  canonicalizeFinish,
  DEFAULT_FINISH_CATALOG,
  mergeFinishLists,
  normalizeFinishKey,
  parseFinishesFromTags,
  type FinishCatalog,
} from "./finishes";
import { readProductText } from "./product-text";

/** Words that negate a finish named within the next 3 words of the same clause. */
export const NEGATION_WORDS: ReadonlySet<string> = new Set([
  "no",
  "not",
  "without",
  "never",
  "zero",
  "nor",
  "isn't",
  "isnt",
  "aren't",
  "arent",
  "wasn't",
  "doesn't",
  "lacks",
  "minus",
]);

/**
 * Cues that the rest of a sentence is about another product (cross-sell, layering, swatch
 * notes). Matched case-insensitively as whole words; the text from the cue to the end of the
 * sentence is ignored.
 */
export const CROSS_SELL_CUES: readonly string[] = [
  "pairs? (?:well |perfectly |beautifully |nicely )?with",
  "paired with",
  "layer(?:s|ed|ing)? (?:it |this |them )?(?:over|under|on top of|with|beneath)",
  "(?:shown|pictured|swatched|photographed|worn) (?:here )?(?:over|with|on top of|layered|under)",
  "try (?:it |this )?(?:with|over|under|our|pairing|layering)",
  "(?:use|wear|apply) (?:it |this )?(?:with|over|under|on top of)",
  "you (?:may|might|will) also (?:like|love)",
  "also (?:available|try|check out)",
  "check out",
  "shop (?:the|our)",
  "goes (?:great|well|perfectly|beautifully) with",
  "looks? (?:great|amazing|stunning|gorgeous|best|perfect) (?:with|over|on top of)",
  "complete the look",
  "sold separately",
  "(?:sister|sibling|companion|matching|coordinating) (?:shade|polish|topper|glitter|lacquer)s?",
  "similar to",
  "compared (?:to|with)",
  "unlike",
];

/** Finish words that are also everyday English; they need finish context to count. */
export const AMBIGUOUS_FINISH_WORDS: ReadonlySet<string> = new Set(["glow", "cream", "creamy", "sheer"]);

/** Nouns that make an ambiguous finish word read as a finish ("sheer polish", "creamy formula"). */
export const FINISH_CONTEXT_NOUNS: readonly string[] = [
  "finish",
  "polish",
  "lacquer",
  "formula",
  "enamel",
  "varnish",
  "effect",
  "base",
  "texture",
  "look",
  "nails?",
];

/** Descriptor namespaces whose values are parsed (others such as `color:` are skipped). */
const PARSED_DESCRIPTOR_NAMESPACES: ReadonlySet<string> = new Set(["finish", "type", "effect", "texture"]);

/** Finish names never matched in free text (the catch-all would match the word "other"). */
const TEXT_EXCLUDED_FINISHES: ReadonlySet<string> = new Set(["other"]);
const MIN_PHRASE_CHARS = 3;
const NEGATION_WINDOW_WORDS = 3;

const CROSS_SELL_REGEX = new RegExp(`(?<![\\p{L}\\p{N}])(?:${CROSS_SELL_CUES.join("|")})(?![\\p{L}\\p{N}])`, "iu");
const SENTENCE_SPLIT = /[.!?\n•|]+/;
const CLAUSE_BREAK = /[,;:()[\]{}–—]/g;
const FOLLOWING_FREE = /^[\s-]*free(?![\p{L}\p{N}])/iu;
const FOLLOWING_COAT = /^[\s-]*(?:top|base)[\s-]?coats?(?![\p{L}\p{N}])/iu;
const FOLLOWING_CONTEXT = new RegExp(
  `^(?:[\\s-]+[\\p{L}'-]+){0,2}?[\\s-]+(?:${FINISH_CONTEXT_NOUNS.join("|")})(?![\\p{L}\\p{N}])`,
  "iu"
);
const WORD_SPLIT = /[^\p{L}\p{N}']+/u;
const NAMESPACE_PATTERN = /^([a-z][a-z _-]*?)\s*:\s*(.*)$/i;

export type FinishTextMode = "descriptor" | "description";

interface FinishPhrase {
  /** Normalized phrase key (e.g. `linear holo`). */
  key: string;
  finish: string;
  regex: RegExp;
  ambiguous: boolean;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const phraseCache = new WeakMap<FinishCatalog, FinishPhrase[]>();

/** Catalog names + aliases as match patterns, longest first. Cached per catalog object. */
function phrasesFor(catalog: FinishCatalog): FinishPhrase[] {
  const cached = phraseCache.get(catalog);
  if (cached) return cached;

  const byKey = new Map<string, string>();
  const add = (raw: string) => {
    // Hyphens and underscores are separators, like spaces ("glow-in-the-dark" = "glow in the dark").
    const key = normalizeFinishKey(raw.replace(/[-_]+/g, " "));
    if (key.length < MIN_PHRASE_CHARS || byKey.has(key)) return;
    const finish = canonicalizeFinish(raw, catalog);
    if (!finish || TEXT_EXCLUDED_FINISHES.has(finish)) return;
    byKey.set(key, finish);
  };
  for (const name of catalog.validNames) add(name);
  for (const alias of catalog.aliases.keys()) add(alias);

  const phrases = [...byKey.entries()]
    .map(([key, finish]) => ({
      key,
      finish,
      regex: new RegExp(
        `(?<![\\p{L}\\p{N}])${key.split(" ").map(escapeRegex).join("[\\s_-]+")}(?:e?s)?(?![\\p{L}\\p{N}])`,
        "giu"
      ),
      ambiguous: AMBIGUOUS_FINISH_WORDS.has(key),
    }))
    .sort((a, b) => b.key.length - a.key.length || a.key.localeCompare(b.key));
  phraseCache.set(catalog, phrases);
  return phrases;
}

function isNegated(segment: string, start: number, end: number): boolean {
  if (FOLLOWING_FREE.test(segment.slice(end))) return true;
  const before = segment.slice(0, start);
  CLAUSE_BREAK.lastIndex = 0;
  let clauseStart = 0;
  for (let match = CLAUSE_BREAK.exec(before); match; match = CLAUSE_BREAK.exec(before)) {
    clauseStart = match.index + 1;
  }
  const words = before
    .slice(clauseStart)
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .split(WORD_SPLIT)
    .filter(Boolean);
  // "non" is a prefix ("non-holo"): it only negates the word right after it.
  if (words[words.length - 1] === "non") return true;
  return words.slice(-NEGATION_WINDOW_WORDS).some((word) => NEGATION_WORDS.has(word));
}

interface TextMatch {
  start: number;
  finish: string;
}

/** Matches in one segment (a sentence or one descriptor), in text order. */
function matchSegment(segment: string, catalog: FinishCatalog, mode: FinishTextMode): TextMatch[] {
  const taken: Array<[number, number]> = [];
  const accepted: TextMatch[] = [];
  const wholeKey = normalizeFinishKey(segment.replace(/[-_]+/g, " "));

  for (const phrase of phrasesFor(catalog)) {
    phrase.regex.lastIndex = 0;
    for (let match = phrase.regex.exec(segment); match; match = phrase.regex.exec(segment)) {
      const start = match.index;
      const end = start + match[0].length;
      if (taken.some(([s, e]) => start < e && end > s)) continue;
      // A longer phrase consumes its range even when rejected, so "no holo glitter" does not
      // fall back to "glitter".
      taken.push([start, end]);

      if (isNegated(segment, start, end)) continue;
      const after = segment.slice(end);
      if (FOLLOWING_COAT.test(after)) continue;
      if (phrase.ambiguous) {
        const standalone = mode === "descriptor" && wholeKey.replace(/e?s$/, "") === phrase.key;
        if (!standalone && !FOLLOWING_CONTEXT.test(after)) continue;
      }
      accepted.push({ start, finish: phrase.finish });
    }
  }
  return accepted.sort((a, b) => a.start - b.start);
}

function dedupe(finishes: string[]): string[] {
  return [...new Set(finishes)];
}

export interface FinishTextOptions {
  /**
   * Phrases blanked out before matching, case-insensitively as whole words: pass the brand so
   * "Holo Taco" or "Glitter Gal" is not read as a finish.
   */
  ignore?: ReadonlyArray<string | null | undefined>;
}

function maskIgnored(text: string, options?: FinishTextOptions): string {
  let out = text;
  for (const phrase of options?.ignore ?? []) {
    const words = typeof phrase === "string" ? phrase.trim().split(/[\s_-]+/).filter(Boolean) : [];
    if (words.length === 0) continue;
    const regex = new RegExp(`(?<![\\p{L}\\p{N}])${words.map(escapeRegex).join("[\\s_-]+")}(?![\\p{L}\\p{N}])`, "giu");
    out = out.replace(regex, " ");
  }
  return out;
}

/**
 * Finishes named in vendor description text, in order of first mention. Applies the negation,
 * cross-sell, top-coat and ambiguous-word guards described at the top of this module.
 */
export function parseFinishesFromText(
  text: unknown,
  catalog: FinishCatalog = DEFAULT_FINISH_CATALOG,
  options?: FinishTextOptions
): string[] {
  if (typeof text !== "string" || !text.trim()) return [];
  const finishes: string[] = [];
  for (const sentence of maskIgnored(text, options).split(SENTENCE_SPLIT)) {
    const cue = CROSS_SELL_REGEX.exec(sentence);
    const relevant = cue ? sentence.slice(0, cue.index) : sentence;
    if (!relevant.trim()) continue;
    finishes.push(...matchSegment(relevant, catalog, "description").map((m) => m.finish));
  }
  return dedupe(finishes);
}

/**
 * Finishes named in product descriptors (product type, variant options, tags, collection
 * names), in descriptor order. Each descriptor is matched on its own; namespaced descriptors
 * other than `finish:` / `type:` / `effect:` / `texture:` are skipped.
 */
export function parseFinishesFromDescriptors(
  descriptors: unknown,
  catalog: FinishCatalog = DEFAULT_FINISH_CATALOG,
  options?: FinishTextOptions
): string[] {
  if (!Array.isArray(descriptors)) return [];
  const finishes: string[] = [];
  for (const descriptor of descriptors) {
    if (typeof descriptor !== "string") continue;
    let value = descriptor.trim();
    if (!value) continue;
    const namespaced = NAMESPACE_PATTERN.exec(value);
    if (namespaced) {
      if (!PARSED_DESCRIPTOR_NAMESPACES.has(namespaced[1].trim().toLowerCase())) continue;
      value = namespaced[2];
    }
    value = maskIgnored(value, options);
    finishes.push(...matchSegment(value, catalog, "descriptor").map((m) => m.finish));
  }
  return dedupe(finishes);
}

/** Where an ingested product's finishes came from, most to least trusted. */
export type IngestedFinishSource = "tags" | "descriptors" | "description" | "none";

export interface IngestedFinishResolution {
  finishes: string[];
  source: IngestedFinishSource;
}

export interface ProductFinishInput {
  tags?: unknown;
  descriptors?: unknown;
  descriptionText?: unknown;
  /** Brand name, masked out of descriptors and description text before matching. */
  brand?: string | null;
}

/**
 * Finishes for an ingested product, by precedence: vendor tags (`finish:<value>` and bare finish
 * tags, `parseFinishesFromTags`) win; descriptor matches are used only when the tags name no
 * finish; description-text matches only when tags and descriptors both name none. The first
 * source that yields anything is the only one used, so lower-confidence text never adds to
 * explicit tag finishes.
 */
export function resolveProductFinishes(
  input: ProductFinishInput,
  catalog: FinishCatalog = DEFAULT_FINISH_CATALOG
): IngestedFinishResolution {
  const fromTags = parseFinishesFromTags(input.tags, catalog);
  if (fromTags.length > 0) return { finishes: fromTags, source: "tags" };
  const textOptions: FinishTextOptions = { ignore: [input.brand] };
  const fromDescriptors = parseFinishesFromDescriptors(input.descriptors, catalog, textOptions);
  if (fromDescriptors.length > 0) return { finishes: fromDescriptors, source: "descriptors" };
  const fromDescription = parseFinishesFromText(input.descriptionText, catalog, textOptions);
  if (fromDescription.length > 0) return { finishes: fromDescription, source: "description" };
  return { finishes: [], source: "none" };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * `resolveProductFinishes` for a connector `normalized` record / `external_product.normalized_json`:
 * reads `tags`, `descriptors`, `descriptionText` and `brand` (masked out of the text).
 */
export function resolveNormalizedProductFinishes(
  normalized: Record<string, unknown> | null | undefined,
  catalog: FinishCatalog = DEFAULT_FINISH_CATALOG
): IngestedFinishResolution {
  if (!normalized || typeof normalized !== "object") return { finishes: [], source: "none" };
  const { descriptionText, descriptors } = readProductText(normalized);
  const brand = typeof normalized.brand === "string" ? normalized.brand : null;
  return resolveProductFinishes({ tags: stringArray(normalized.tags), descriptors, descriptionText, brand }, catalog);
}

/**
 * The `shade.finishes` value ingestion writes for a resolution, or `null` to leave it untouched.
 * - `tags`: merged into the current finishes (never removing), as ingestion always did.
 * - `descriptors` / `description`: only fill a shade that has no finishes yet; text never adds
 *   to or reorders finishes that are already there (manual edits, earlier tag runs).
 * - `none`: untouched.
 * Ingestion-only (catalog write rule #224): user requests never go through this.
 */
export function applyIngestedFinishes(
  current: readonly string[] | null | undefined,
  resolution: IngestedFinishResolution,
  catalog: FinishCatalog = DEFAULT_FINISH_CATALOG
): string[] | null {
  if (resolution.finishes.length === 0) return null;
  if (resolution.source === "tags") {
    return mergeFinishLists([current ?? [], resolution.finishes], catalog);
  }
  return (current ?? []).length > 0 ? null : [...resolution.finishes];
}
