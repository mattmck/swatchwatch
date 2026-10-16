/**
 * Picks the product photo most likely to show the polish on a nail, so AI hex
 * detection looks at the swatch rather than the bottle, box or lifestyle shot
 * that Shopify stores usually put first.
 *
 * Pure and dependency-free: scores come from alt-text keywords (strong signal)
 * and from the URL/filename (weak signal). `confident` is only ever true when
 * the alt text itself points at an on-nail photo, so callers can fall back to
 * the vendor's primary image when the signal is weak or absent.
 */

export interface ProductImageCandidate {
  url: string;
  /** Shopify image alt text when the vendor set one. */
  alt?: string | null;
  /** Shopify image position (1-based) when known. */
  position?: number | null;
}

/** Alt-text words that mean "the polish is on a nail". */
export const POSITIVE_ALT_KEYWORDS: readonly string[] = [
  "swatch",
  "swatches",
  "swatched",
  "nail",
  "nails",
  "hand",
  "hands",
  "macro",
  "close-up",
  "closeup",
  "close up",
  "finger",
  "fingers",
  "mani",
  "manicure",
];

/** Alt-text words that mean "this is the product, not the color". */
export const NEGATIVE_ALT_KEYWORDS: readonly string[] = [
  "bottle",
  "bottles",
  "cap",
  "caps",
  "box",
  "boxes",
  "packaging",
  "collection",
  "set",
  "sets",
  "lifestyle",
  "bundle",
];

/** Filename hints, weaker than alt text (Holo Taco: `..._hand2_..._sq.jpg`; Mooncat: `..._swatch...`). */
export const POSITIVE_URL_KEYWORDS: readonly string[] = ["swatch", "swatches", "nail", "nails", "hand", "hands", "macro"];
export const NEGATIVE_URL_KEYWORDS: readonly string[] = ["bottle", "bottles", "hero", "heroes", "box", "packaging", "lifestyle"];

export const ALT_KEYWORD_WEIGHT = 3;
export const URL_KEYWORD_WEIGHT = 1;

export interface ImageScore {
  /** Net score; higher is a better detection candidate. */
  score: number;
  /** Alt-text contribution (positive hits minus negative hits, weighted). */
  altScore: number;
  /** URL/filename contribution (weighted). */
  urlScore: number;
  altPositive: string[];
  altNegative: string[];
  urlPositive: string[];
  urlNegative: string[];
  /** True when the alt text alone says this is an on-nail photo. */
  confident: boolean;
}

export interface RankedImage extends ImageScore {
  url: string;
  alt: string | null;
  position: number | null;
  /** Index of this image in the input array. */
  index: number;
  /** Human-readable explanation of the score, for logs and eval meta. */
  reason: string;
}

export type ImageSelectionSource = "ranked" | "primary" | "none";

export interface ImageSelection {
  /** Chosen image URL, or null when nothing was available. */
  url: string | null;
  /** Why this image was chosen. */
  reason: string;
  /** True when the choice came from a confident alt-text signal. */
  confident: boolean;
  /** `ranked` = top of the ranking; `primary` = fallback to the primary image; `none` = nothing to choose. */
  source: ImageSelectionSource;
  /** The full ranking, best first. */
  ranked: RankedImage[];
}

function tokenize(text: string): string[] {
  // Split on anything that is not a letter or digit so "close-up", "hand2" and
  // "Bottle-Heroes" all yield clean word tokens; keep the raw lowercase text for
  // the multi-word keyword ("close up").
  // camelCase boundaries are split first so filenames like "BottleMacro" or
  // "BottleHeroes" contribute both words.
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((token) => token.replace(/\d+$/, ""))
    .filter(Boolean);
}

function keywordHits(text: string, keywords: readonly string[]): string[] {
  const lowered = text.toLowerCase();
  const tokens = new Set(tokenize(text));
  const hits = new Set<string>();
  for (const keyword of keywords) {
    if (keyword.includes(" ") || keyword.includes("-")) {
      // Multi-word keyword: match on the normalized phrase (hyphens treated as spaces).
      const phrase = keyword.replace(/-/g, " ");
      if (lowered.replace(/[^a-z0-9]+/g, " ").includes(` ${phrase} `) || lowered.replace(/[^a-z0-9]+/g, " ").trim() === phrase) {
        hits.add(canonicalKeyword(keyword));
      }
      continue;
    }
    if (tokens.has(keyword)) {
      hits.add(canonicalKeyword(keyword));
    }
  }
  return [...hits].sort();
}

/** Collapse plural/variant spellings so reasons read `nail`, `swatch`, `close-up`. */
function canonicalKeyword(keyword: string): string {
  switch (keyword) {
    case "swatches":
    case "swatched":
      return "swatch";
    case "nails":
      return "nail";
    case "hands":
      return "hand";
    case "closeup":
    case "close up":
      return "close-up";
    case "fingers":
      return "finger";
    case "mani":
    case "manicure":
      return "manicure";
    case "bottles":
      return "bottle";
    case "caps":
      return "cap";
    case "boxes":
      return "box";
    case "sets":
      return "set";
    case "heroes":
      return "hero";
    default:
      return keyword;
  }
}

function urlPathForScoring(url: string): string {
  // Only the path/filename carries meaning; query strings (`?v=...`) are cache busters.
  const withoutQuery = url.split(/[?#]/, 1)[0] ?? url;
  try {
    return decodeURIComponent(withoutQuery);
  } catch {
    return withoutQuery;
  }
}

/** Score one image. Pure. */
export function scoreImageForColorDetection(image: ProductImageCandidate): ImageScore {
  const alt = typeof image.alt === "string" ? image.alt.trim() : "";
  const altPositive = alt ? keywordHits(alt, POSITIVE_ALT_KEYWORDS) : [];
  const altNegative = alt ? keywordHits(alt, NEGATIVE_ALT_KEYWORDS) : [];
  const altScore = (altPositive.length - altNegative.length) * ALT_KEYWORD_WEIGHT;

  const urlText = typeof image.url === "string" ? urlPathForScoring(image.url) : "";
  const urlPositive = urlText ? keywordHits(urlText, POSITIVE_URL_KEYWORDS) : [];
  const urlNegative = urlText ? keywordHits(urlText, NEGATIVE_URL_KEYWORDS) : [];
  const urlScore = (urlPositive.length - urlNegative.length) * URL_KEYWORD_WEIGHT;

  return {
    score: altScore + urlScore,
    altScore,
    urlScore,
    altPositive,
    altNegative,
    urlPositive,
    urlNegative,
    confident: altPositive.length > 0 && altScore > 0,
  };
}

function describe(score: ImageScore): string {
  const parts: string[] = [];
  if (score.altPositive.length) parts.push(`alt mentions ${score.altPositive.join(", ")}`);
  if (score.altNegative.length) parts.push(`alt mentions ${score.altNegative.join(", ")} (penalized)`);
  if (score.urlPositive.length) parts.push(`url mentions ${score.urlPositive.join(", ")} (weak)`);
  if (score.urlNegative.length) parts.push(`url mentions ${score.urlNegative.join(", ")} (weak penalty)`);
  if (!parts.length) return "no alt or url signal";
  return parts.join("; ");
}

function sortKey(image: RankedImage): number {
  return typeof image.position === "number" ? image.position : Number.MAX_SAFE_INTEGER;
}

/**
 * Rank images for AI color detection, best first. Ties keep vendor order
 * (position, then input index). Entries without a usable URL are dropped.
 */
export function rankImagesForColorDetection(
  images: ReadonlyArray<ProductImageCandidate> | null | undefined
): RankedImage[] {
  if (!Array.isArray(images)) return [];
  const ranked: RankedImage[] = [];
  images.forEach((image, index) => {
    const url = typeof image?.url === "string" ? image.url.trim() : "";
    if (!url) return;
    const score = scoreImageForColorDetection({ ...image, url });
    const position =
      typeof image.position === "number" && Number.isInteger(image.position) ? image.position : null;
    ranked.push({
      ...score,
      url,
      alt: typeof image.alt === "string" && image.alt.trim() ? image.alt.trim() : null,
      position,
      index,
      reason: `score ${score.score}: ${describe(score)}`,
    });
  });
  ranked.sort((a, b) => b.score - a.score || sortKey(a) - sortKey(b) || a.index - b.index);
  return ranked;
}

/**
 * Choose the image to send to AI detection: the top-ranked image when its alt
 * text gives a confident on-nail signal, otherwise `primaryUrl` (the vendor's
 * first image, today's behaviour).
 */
export function selectImageForColorDetection(
  images: ReadonlyArray<ProductImageCandidate> | null | undefined,
  primaryUrl: string | null | undefined
): ImageSelection {
  const ranked = rankImagesForColorDetection(images);
  const primary = typeof primaryUrl === "string" && primaryUrl.trim() ? primaryUrl.trim() : null;
  const top = ranked[0];

  if (top?.confident) {
    const ordinal = top.position ?? top.index + 1;
    return {
      url: top.url,
      reason: `image #${ordinal} ranked best (${top.reason})`,
      confident: true,
      source: "ranked",
      ranked,
    };
  }

  if (primary) {
    const why = top
      ? `no confident alt-text signal (best candidate: ${top.reason})`
      : "no image metadata available";
    return {
      url: primary,
      reason: `falling back to primary image: ${why}`,
      confident: false,
      source: "primary",
      ranked,
    };
  }

  if (top) {
    return {
      url: top.url,
      reason: `no primary image; using best-ranked image (${top.reason})`,
      confident: false,
      source: "ranked",
      ranked,
    };
  }

  return { url: null, reason: "no images available", confident: false, source: "none", ranked };
}

/**
 * Read image candidates off a connector's `normalized` record: the
 * `images` rows (`{ url, alt, position }`) when the connector stored them,
 * otherwise bare `imageUrls` (records ingested before alt text was kept).
 */
export function parseProductImageCandidates(
  images: unknown,
  imageUrls: ReadonlyArray<unknown> | null | undefined
): ProductImageCandidate[] {
  if (Array.isArray(images)) {
    const parsed: ProductImageCandidate[] = [];
    for (const entry of images) {
      if (!entry || typeof entry !== "object") continue;
      const row = entry as Record<string, unknown>;
      const url = typeof row.url === "string" ? row.url.trim() : "";
      if (!url) continue;
      parsed.push({
        url,
        alt: typeof row.alt === "string" && row.alt.trim() ? row.alt.trim() : null,
        position: typeof row.position === "number" && Number.isInteger(row.position) ? row.position : null,
      });
    }
    if (parsed.length) return parsed;
  }
  const urls = Array.isArray(imageUrls)
    ? imageUrls.filter((url): url is string => typeof url === "string" && url.trim() !== "")
    : [];
  return urls.map((url, index) => ({ url: url.trim(), alt: null, position: index + 1 }));
}

export interface UploadedImageRef {
  /** The vendor URL the blob was copied from. */
  sourceUrl: string;
  /** Blob storage URL (what AI detection is given, via the image proxy). */
  storageUrl: string;
}

export interface UploadedImageChoice {
  /** Blob to hand to detection; null when neither the choice nor the primary was uploaded. */
  storageUrl: string | null;
  /** Vendor URL of the blob actually used. */
  sourceUrl: string | null;
  /** The ranking decision, before upload availability was considered. */
  selection: ImageSelection;
  /** True when the ranked choice had no uploaded blob and the primary was used instead. */
  uploadFallback: boolean;
  /** Final explanation, including any upload fallback. */
  reason: string;
}

/**
 * Combine the ranking with what actually got uploaded: detection can only run
 * on a blob, so a ranked choice whose upload failed falls back to the primary blob.
 */
export function chooseUploadedImageForDetection(
  images: ReadonlyArray<ProductImageCandidate> | null | undefined,
  primaryUrl: string | null | undefined,
  uploaded: ReadonlyArray<UploadedImageRef>
): UploadedImageChoice {
  const selection = selectImageForColorDetection(images, primaryUrl);
  const byUrl = new Map(uploaded.map((ref) => [ref.sourceUrl, ref.storageUrl] as const));

  const chosenBlob = selection.url ? byUrl.get(selection.url) ?? null : null;
  if (chosenBlob) {
    return { storageUrl: chosenBlob, sourceUrl: selection.url, selection, uploadFallback: false, reason: selection.reason };
  }

  const primary = typeof primaryUrl === "string" && primaryUrl.trim() ? primaryUrl.trim() : null;
  const primaryBlob = primary ? byUrl.get(primary) ?? null : null;
  if (primaryBlob && selection.url && selection.url !== primary) {
    return {
      storageUrl: primaryBlob,
      sourceUrl: primary,
      selection,
      uploadFallback: true,
      reason: `${selection.reason}; chosen image was not uploaded, using primary image blob instead`,
    };
  }

  return { storageUrl: primaryBlob, sourceUrl: selection.url ?? primary, selection, uploadFallback: false, reason: selection.reason };
}
