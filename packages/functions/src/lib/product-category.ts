/**
 * Product-category classifier (#349, #347; decision D23, plan docs/plan-catalog-hygiene.md §4
 * Phase 3).
 *
 * `docs/queries/catalog-hygiene-audit.sql` is the reference: this applies the same rules in the
 * same order, and the two must never disagree. To change a rule, change the audit query first,
 * re-review its section 6 samples, then mirror it here (tests/product-category.unit.test.cjs is
 * built from those samples).
 *
 * Text, all lower-cased:
 *   strong  the shade name + color name + every linked source product's title and product type
 *   all     strong + the products' tags, with `_`/`-` runs turned into spaces
 *
 * Rules, first match wins:
 *   1. accessory  a tool/accessory word in the STRONG text (never free-form tags: Holo Taco tags a
 *                 magnetic polish `magnetic-wand`; ambiguous words such as jewels/foils/studs only when
 *                 the product has a product type that names no polish), or an explicit accessory type tag
 *                 (`nail-tool`, `type:nail-tool`, `type:accessories`, ...);
 *   2. topper     `topper` among the finishes or detected finishes, or the word topper(s) anywhere
 *                 (tags included), so it beats coat wording (Holo Taco files flakie toppers under
 *                 product type "Top Coat");
 *   3. base_coat  base coat, ridge filler, primer, bonder, bond;
 *   4. top_coat   top coat, sealer, sealant, quick dry top;
 *   5. treatment  treatment, strengthener, hardener, cuticle oil, cuticle, growth serum;
 *                 rules 3–5 run over the strong text first, then over the tags (a "Top Coat"
 *                 title beats a "Top & Base Coat" tag);
 *   6. color      everything else.
 * Words match whole (`\b`, like Postgres `\m … \M`), case-insensitively.
 */
import type { ProductCategory } from "swatchwatch-shared";

/** Which signal decided the category; null for the `color` default. */
export type ProductCategoryEvidence = "text" | "type-tag" | "finish" | "tag" | "legacy-tag" | null;

export interface ProductCategoryResult {
  category: ProductCategory;
  evidence: ProductCategoryEvidence;
}

/** One linked source product (title, product type, tags), as the audit reads it. */
export interface ProductCategorySourceProduct {
  title?: string | null;
  productType?: string | null;
  tags?: readonly string[] | null;
}

export interface ProductCategoryInput {
  shadeName?: string | null;
  colorName?: string | null;
  finishes?: readonly string[] | null;
  detectedFinishes?: readonly string[] | null;
  products?: readonly ProductCategorySourceProduct[] | null;
}

/** Accessory words that are unambiguous in a shade name, title or product type. */
const ACCESSORY_REGEX =
  /\b(?:stamp(?:ing|er|ers)?|plates?|buffers?|files?|brush(?:es)?|tools?|charms?|decals?|stickers?|kits?|stencils?|lamps?|magnets?|pushers?|clippers?|removers?|wipes?|dehydrators?|gift ?cards?|mystery box)\b/;
/**
 * Accessory words that also name polishes ("Crown Jewels", "Foil Finish", "Stud Muffin"). They count
 * only for a product that has a product type none of whose types names a polish.
 */
const AMBIGUOUS_ACCESSORY_REGEX =
  /\b(?:jewels?|jewelry|studs?|rhinestones?|foils?|tapes?|wands?|racks?|displays?|totes?|samplers?)\b/;
/** Whole tags (after lower-casing) that declare the product type as a tool/accessory. */
const ACCESSORY_TYPE_TAG_REGEX = /^(?:type:)?(?:nail[-_ ]?)?(?:tools?|accessor(?:y|ies))$/;
const TOPPER_REGEX = /\btoppers?\b/;
const BASE_COAT_REGEX = /\b(?:base ?coats?|basecoats?|ridge filler|primer|bonder|bond)\b/;
const TOP_COAT_REGEX = /\b(?:top ?coats?|topcoats?|sealer|sealant|quick ?dry top)\b/;
const TREATMENT_REGEX = /\b(?:treatments?|strengthener|hardener|cuticle oil|cuticle|growth serum)\b/;

/**
 * The June (#183/#184) connector tag blocklist minus the coat/treatment words (cuticle, treatment,
 * primer, bond), which are ingested now (D-E). Connector gate only: it rejects, it never classifies
 * a stored shade, so the backfill and the audit query do not use it.
 */
const LEGACY_TAG_BLOCKLIST_REGEX =
  /\b(?:stamp|plate|brush|tool|file|buffer|lamp|decal|sticker|kit|remover|wipe|dehydrator)(?:s|es)?\b/;

/** The legacy polish signal (nail polish / lacquer / varnish / enamel), from `isNailPolish`. */
const POLISH_SIGNAL_REGEX = /\b(?:nail\s*)?(?:polish(?:es)?|lacquers?|varnish(?:es)?|enamels?)\b/;

function joinText(parts: ReadonlyArray<string | null | undefined>): string {
  return parts.filter((part): part is string => typeof part === "string" && part.trim() !== "").join(" ");
}

function hasFinish(finishes: readonly string[] | null | undefined, name: string): boolean {
  return (finishes ?? []).some((finish) => typeof finish === "string" && finish.trim().toLowerCase() === name);
}

/** Classify a shade from its names, finishes and linked source products. Pure. */
export function classifyProductCategory(input: ProductCategoryInput): ProductCategoryResult {
  const products = input.products ?? [];
  const strongText = joinText([
    input.shadeName,
    input.colorName,
    ...products.flatMap((product) => [product.title, product.productType]),
  ]).toLowerCase();
  const tags = products.flatMap((product) => (product.tags ?? []).filter((tag) => typeof tag === "string"));
  const tagText = joinText(tags).toLowerCase().replace(/[_-]+/g, " ");
  const strongSpaced = strongText.replace(/[_-]+/g, " ");
  const allText = joinText([strongSpaced, tagText]);

  const typeText = joinText(products.map((product) => product.productType)).toLowerCase().replace(/[_-]+/g, " ");
  const typedNonPolish = typeText !== "" && !POLISH_SIGNAL_REGEX.test(typeText);

  if (ACCESSORY_REGEX.test(strongText)) return { category: "accessory", evidence: "text" };
  if (typedNonPolish && AMBIGUOUS_ACCESSORY_REGEX.test(strongText)) {
    return { category: "accessory", evidence: "text" };
  }
  if (tags.some((tag) => ACCESSORY_TYPE_TAG_REGEX.test(tag.trim().toLowerCase()))) {
    return { category: "accessory", evidence: "type-tag" };
  }

  if (hasFinish(input.finishes, "topper") || hasFinish(input.detectedFinishes, "topper")) {
    return { category: "topper", evidence: "finish" };
  }
  if (TOPPER_REGEX.test(allText)) {
    return { category: "topper", evidence: TOPPER_REGEX.test(strongSpaced) ? "text" : "tag" };
  }

  const coatRules: ReadonlyArray<[ProductCategory, RegExp]> = [
    ["base_coat", BASE_COAT_REGEX],
    ["top_coat", TOP_COAT_REGEX],
    ["treatment", TREATMENT_REGEX],
  ];
  // Strong text first, then tags: Cirque tags every coat "Top & Base Coat", and its
  // "Looking Glass Top Coat" title must win over that tag.
  for (const [category, regex] of coatRules) {
    if (regex.test(strongSpaced)) return { category, evidence: "text" };
  }
  for (const [category, regex] of coatRules) {
    if (regex.test(tagText)) return { category, evidence: "tag" };
  }

  return { category: "color", evidence: null };
}

/**
 * The legacy polish signal in a product's type or tags (`nail polish`, `polish`, `lacquer`,
 * `varnish`, `enamel` and their plurals; `nailpolish` too). `_`/`-` count as spaces.
 */
export function hasPolishSignal(productType: string | null | undefined, tags: readonly string[]): boolean {
  const haystack = [productType ?? "", ...tags].join(" ").toLowerCase().replace(/[_-]+/g, " ");
  return POLISH_SIGNAL_REGEX.test(haystack);
}

export interface IngestedProductInput {
  title?: string | null;
  productType?: string | null;
  tags?: readonly string[] | null;
  finishes?: readonly string[] | null;
}

export interface IngestedProductClassification extends ProductCategoryResult {
  /** False for accessories, and for products with neither a polish signal nor a category. */
  accept: boolean;
}

/**
 * Connector gate (#347): classify one source product and decide whether to ingest it. Accessories
 * are always skipped, and so is a product whose tags hit the June tag blocklist (`legacy-tag`).
 * Otherwise a product is ingested when its type or tags carry a polish signal, or when it is a
 * topper, coat or treatment (base coats are often typed "Base Coat" with no polish word; D-E).
 */
export function classifyIngestedProduct(input: IngestedProductInput): IngestedProductClassification {
  const tags = (input.tags ?? []).filter((tag): tag is string => typeof tag === "string");
  const result = classifyProductCategory({
    shadeName: input.title,
    finishes: input.finishes,
    products: [{ productType: input.productType, tags }],
  });
  const tagText = tags.join(" ").toLowerCase().replace(/[_-]+/g, " ");
  if (result.category !== "accessory" && LEGACY_TAG_BLOCKLIST_REGEX.test(tagText)) {
    return { category: "accessory", evidence: "legacy-tag", accept: false };
  }
  const accept =
    result.category !== "accessory" &&
    (result.category !== "color" || hasPolishSignal(input.productType, tags));
  return { ...result, accept };
}
