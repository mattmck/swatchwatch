/**
 * Per-product image download cap (`SOURCE_IMAGE_MAX_PER_PRODUCT`): brand stores list about 30
 * photos per product (Cracked Polish, Bee's Knees), and ingestion used to download, normalise and
 * thumbnail every one of them. This decides, before any download, which of a product's listed
 * images ingestion stores this run. Pure and dependency-free apart from the image ranking.
 *
 * Rule (in this order, one decision per distinct http(s) URL of `imageUrls`, index 0 = primary):
 * 1. the primary image always;
 * 2. the image AI hex detection would choose (`selectImageForColorDetection`: the top-ranked image
 *    when its alt text confidently says "on a nail"), always, even past the cap, so detection and
 *    the pinned gallery link see the same photo they would without a cap;
 * 3. then the other images in vendor order until `maxImages` images are kept in all.
 * Everything else is "skipped by the cap": not downloaded. The caller still reuses a skipped image
 * whose URL an earlier run already stored (no download needed), so introducing or lowering the cap
 * never unlinks a gallery image the vendor still lists; see ingestion-repo.ts.
 */
import { type ProductImageCandidate, selectImageForColorDetection } from "./image-selection";

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** Images kept per product when `SOURCE_IMAGE_MAX_PER_PRODUCT` is unset, empty, 0 or invalid. */
export const DEFAULT_SOURCE_IMAGE_MAX_PER_PRODUCT = 8;
/** Largest accepted `SOURCE_IMAGE_MAX_PER_PRODUCT` (larger values are clamped to it). */
export const MAX_SOURCE_IMAGE_MAX_PER_PRODUCT = 50;

/**
 * Max images (primary included) ingestion downloads and stores per product per run. A positive
 * integer, clamped to `MAX_SOURCE_IMAGE_MAX_PER_PRODUCT`; unset, empty, 0 or invalid gives the
 * default 8. There is no "unlimited" value.
 */
export function getSourceImageMaxPerProduct(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SOURCE_IMAGE_MAX_PER_PRODUCT?.trim();
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_SOURCE_IMAGE_MAX_PER_PRODUCT;
  const value = Number.parseInt(raw, 10);
  if (value < 1) return DEFAULT_SOURCE_IMAGE_MAX_PER_PRODUCT;
  return Math.min(value, MAX_SOURCE_IMAGE_MAX_PER_PRODUCT);
}

export interface PlannedProductImage {
  url: string;
  /** Position in the connector's `imageUrls` (names the blob `<externalId>-img<index>`). */
  index: number;
}

export interface ProductImageDownloadPlan {
  /** Additional (non-primary) images to store this run, in vendor order. */
  additional: PlannedProductImage[];
  /** Distinct additional URLs left out by the cap, in vendor order. */
  skippedByCap: string[];
  /** The gallery image kept because AI detection would choose it, or null (detection uses the primary). */
  detectionUrl: string | null;
}

/**
 * Which of a product's images to download (see the module comment). `imageUrls[0]` is the primary
 * and is never part of the result (the caller stores it first); repeated URLs, the primary's URL
 * again and non-http(s) entries are dropped without counting against the cap.
 */
export function planProductImageDownloads(params: {
  imageUrls: readonly string[];
  images: ReadonlyArray<ProductImageCandidate> | null | undefined;
  primaryUrl: string | null;
  maxImages: number;
}): ProductImageDownloadPlan {
  const primary = params.primaryUrl ?? params.imageUrls[0] ?? null;
  const seen = new Set<string>(primary ? [primary] : []);
  const candidates: PlannedProductImage[] = [];
  params.imageUrls.forEach((url, index) => {
    if (index === 0 || !isHttpUrl(url) || seen.has(url)) return;
    seen.add(url);
    candidates.push({ url, index });
  });

  const chosen = selectImageForColorDetection(params.images, primary);
  const detectionUrl =
    chosen.confident && chosen.url && chosen.url !== primary && candidates.some((c) => c.url === chosen.url)
      ? chosen.url
      : null;

  // The primary counts as one kept image; the detection image takes a slot when there is one.
  let slots = Math.max(0, params.maxImages - 1 - (detectionUrl ? 1 : 0));
  const keep = new Set<string>(detectionUrl ? [detectionUrl] : []);
  for (const candidate of candidates) {
    if (slots === 0) break;
    if (keep.has(candidate.url)) continue;
    keep.add(candidate.url);
    slots -= 1;
  }

  return {
    additional: candidates.filter((c) => keep.has(c.url)),
    skippedByCap: candidates.filter((c) => !keep.has(c.url)).map((c) => c.url),
    detectionUrl,
  };
}
