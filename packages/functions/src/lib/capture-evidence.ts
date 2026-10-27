import {
  BottleSurface,
  CaptureBrandConflict,
  CaptureBrandRef,
  CaptureFrameType,
  CaptureQuestion,
  CaptureReadField,
  CaptureReadSummary,
  CaptureSuggestedShade,
  parseBottleSurface,
} from "swatchwatch-shared";

export interface CaptureFrameEvidenceRow {
  frameType: CaptureFrameType;
  quality: Record<string, unknown> | null;
  createdAt?: string;
}

export interface CaptureEvidence {
  gtin?: string;
  /** Decoder format of `gtin` (`ean_13`, `upc_e`, …) when the client reported one. */
  gtinFormat?: string;
  brand?: string;
  shadeName?: string;
  finish?: string;
  /** `hint` when `brand` came from metadata (the user's hint or an answer), `read` when from a frame. */
  brandSource?: "hint" | "read";
  /**
   * Newest frame brand, kept even when a hint wins `brand` (the brand-conflict rule compares
   * them). `source` is the frame's `FrameExtraction.source`: only a `request_quality` (client-sent)
   * brand counts as typed; a `pipeline` one was read off the bottle. `confidence` is 0 when unscored.
   */
  brandRead?: { text: string; confidence: number; source: FrameExtraction["source"] };
  /** Shade name the model picked from a closed list of catalog names. */
  shadeNameListed?: string;
  /** Glass color read from a frame the pipeline marked `extracted.source === "glass"`; never client-supplied. */
  glassHex?: string;
  glassHexConfidence?: number;
  /** Frames per photographed surface (`quality.surface`); unknown surfaces are not counted. */
  surfaces: Partial<Record<BottleSurface, number>>;
  /** Surfaces the user chose to skip (`metadata.bottle.skipped`). */
  skippedSurfaces: BottleSurface[];
}

export interface FrameExtraction {
  gtin?: string;
  gtinFormat?: string;
  brand?: string;
  /** Confidence of the frame-read `brand`; absent for client-supplied evidence. */
  brandConfidence?: number;
  shadeName?: string;
  shadeNameListed?: string;
  finish?: string;
  /** Only set from `extracted.hex` when `extracted.source === "glass"`. */
  hex?: string;
  hexConfidence?: number;
  source: "pipeline" | "request_quality";
}

export type FrameExtractionSource = FrameExtraction["source"] | "none";

export interface CaptureMatchCandidate {
  entityType: "shade" | "sku";
  entityId: number;
  /** Shade the entity resolves to (the shade itself, or a SKU's shade_id). */
  shadeId: number | null;
  display: string;
  confidence: number;
  /** Catalog brand of the shade; set by the bottle resolver only. */
  brandId?: number;
  /** OKLAB distance from the glass photo's hex to the shade's display hex; set by the bottle resolver only. */
  colorDistance?: number | null;
}

export interface CaptureQuestionSpec {
  key: string;
  prompt: string;
  type: CaptureQuestion["type"];
  options?: string[];
}

/** How a barcode match was found: catalog `barcode` row, the caller's learned barcode, or a connector product's GTIN. */
export type BarcodeMatchVia = "catalog" | "user" | "external_product";

/** Brand-first resolver details, set only by the bottle resolver. */
export interface ResolverDecisionBottle {
  brand: CaptureBrandRef | null;
  suggestedShade?: CaptureSuggestedShade;
  brandConflict?: CaptureBrandConflict;
  tie: boolean;
  modelCalls: number;
}

// `candidates` is what the resolver considered, ranked; finalize ignores it, check reports it.
// `barcodeVia` is set when the scanned GTIN matched; `evidence` is what the resolver matched on.
export type ResolverDecision = (
  | {
      status: "matched";
      confidence: number;
      entityType: "shade" | "sku";
      entityId: number;
      candidates: CaptureMatchCandidate[];
      metadataPatch: Record<string, unknown>;
    }
  | {
      status: "needs_question";
      confidence: number;
      question: CaptureQuestionSpec;
      candidates: CaptureMatchCandidate[];
      metadataPatch: Record<string, unknown>;
    }
  | {
      status: "unmatched";
      confidence: number;
      candidates: CaptureMatchCandidate[];
      metadataPatch: Record<string, unknown>;
    }
) & { barcodeVia?: BarcodeMatchVia; bottle?: ResolverDecisionBottle };

export type ResolverOutcome = ResolverDecision & { evidence: CaptureEvidence };

export function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

export function getStringField(
  source: Record<string, unknown> | null | undefined,
  ...keys: string[]
): string | undefined {
  if (!source) return undefined;

  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return undefined;
}

function getNumberField(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function extractFrameEvidence(quality: Record<string, unknown> | null): FrameExtraction | null {
  if (!quality) {
    return null;
  }

  const extracted = toRecord(quality.extracted);
  const glassHex = extracted.source === "glass" ? getStringField(extracted, "hex") : undefined;
  const extractedEvidence = {
    gtin: getStringField(extracted, "gtin", "upc", "ean"),
    gtinFormat: getStringField(extracted, "gtinFormat", "barcodeFormat"),
    brand: getStringField(extracted, "brand"),
    shadeName: getStringField(extracted, "shadeName", "name"),
    finish: getStringField(extracted, "finish"),
    shadeNameListed: getStringField(extracted, "shadeNameListed"),
    hex: glassHex,
  };
  if (
    extractedEvidence.gtin
    || extractedEvidence.brand
    || extractedEvidence.shadeName
    || extractedEvidence.finish
    || extractedEvidence.shadeNameListed
    || extractedEvidence.hex
  ) {
    // A barcode the device decoded on a photo the pipeline also read (a bottle's bottom with its
    // sticker in view) is still evidence; a code the pipeline read itself wins.
    if (!extractedEvidence.gtin) {
      extractedEvidence.gtin = getStringField(quality, "gtin", "upc", "ean");
      extractedEvidence.gtinFormat = extractedEvidence.gtin
        ? getStringField(quality, "barcodeFormat", "gtinFormat")
        : undefined;
    }
    return {
      ...extractedEvidence,
      brandConfidence: getNumberField(extracted, "brandConfidence"),
      hexConfidence: glassHex ? getNumberField(extracted, "hexConfidence") : undefined,
      // Ingest stores a client-sent frame's evidence under `extracted` with its source; the
      // client's own `extracted.source` is stripped on ingest, so only the server writes it.
      source: extracted.source === "request_quality" ? "request_quality" : "pipeline",
    };
  }

  const legacyEvidence = {
    gtin: getStringField(quality, "gtin", "upc", "ean"),
    gtinFormat: getStringField(quality, "barcodeFormat", "gtinFormat"),
    brand: getStringField(quality, "brand"),
    shadeName: getStringField(quality, "shadeName", "name"),
    finish: getStringField(quality, "finish"),
  };
  if (
    legacyEvidence.gtin
    || legacyEvidence.brand
    || legacyEvidence.shadeName
    || legacyEvidence.finish
  ) {
    return {
      ...legacyEvidence,
      source: "request_quality",
    };
  }

  return null;
}

/**
 * Whether a frame of `surface` may supply the shade name. The front is photographed for the
 * brand: its text is the brand, a collection or a tagline, and a closed-set pick off it is a
 * guess, so a name read there would match the bottle before the bottom sticker is seen.
 */
export function surfaceReadsShadeName(surface: BottleSurface | null): boolean {
  return surface !== "front";
}

export function collectCaptureEvidence(
  metadata: Record<string, unknown> | null,
  frames: CaptureFrameEvidenceRow[]
): CaptureEvidence {
  const answers = (metadata?.answers as Record<string, unknown> | undefined) ?? {};
  const brandFromAnswers =
    getStringField(answers.brand_shade as Record<string, unknown>, "brand")
    || getStringField(answers, "brand");
  const shadeFromAnswers =
    getStringField(answers.brand_shade as Record<string, unknown>, "shadeName", "name")
    || getStringField(answers, "shadeName", "name");
  const finishFromAnswers =
    getStringField(answers.brand_shade as Record<string, unknown>, "finish")
    || getStringField(answers, "finish");

  const brandFromMetadata = brandFromAnswers || getStringField(metadata, "brand");
  const skipped = toRecord(metadata?.bottle).skipped;
  const skippedSurfaces: BottleSurface[] = [];
  if (Array.isArray(skipped)) {
    for (const value of skipped) {
      const surface = parseBottleSurface(value);
      if (surface && !skippedSurfaces.includes(surface)) skippedSurfaces.push(surface);
    }
  }

  const evidence: CaptureEvidence = {
    gtin: getStringField(metadata, "gtin"),
    gtinFormat: getStringField(metadata, "barcodeFormat", "gtinFormat"),
    brand: brandFromMetadata,
    brandSource: brandFromMetadata ? "hint" : undefined,
    shadeName: shadeFromAnswers || getStringField(metadata, "shadeName", "name"),
    finish: finishFromAnswers || getStringField(metadata, "finish"),
    surfaces: {},
    skippedSurfaces,
  };

  for (const frame of frames) {
    const quality = frame.quality;
    if (!quality) continue;

    const surface = parseBottleSurface(quality.surface);
    if (surface) {
      evidence.surfaces[surface] = (evidence.surfaces[surface] ?? 0) + 1;
    }

    const extracted = extractFrameEvidence(quality);
    if (!extracted) {
      continue;
    }

    if (!evidence.gtin && extracted.gtin) {
      evidence.gtin = extracted.gtin;
      evidence.gtinFormat = extracted.gtinFormat;
    }
    if (!evidence.brand) {
      evidence.brand = extracted.brand;
      if (extracted.brand) evidence.brandSource = "read";
    }
    if (!evidence.brandRead && extracted.brand) {
      evidence.brandRead = { text: extracted.brand, confidence: extracted.brandConfidence ?? 0, source: extracted.source };
    }
    if (surfaceReadsShadeName(surface)) {
      if (!evidence.shadeName) {
        evidence.shadeName = extracted.shadeName;
      }
      if (!evidence.shadeNameListed) {
        evidence.shadeNameListed = extracted.shadeNameListed;
      }
    }
    if (!evidence.finish) {
      evidence.finish = extracted.finish;
    }
    if (!evidence.glassHex && extracted.hex) {
      evidence.glassHex = extracted.hex;
      evidence.glassHexConfidence = extracted.hexConfidence;
    }
  }

  return evidence;
}

/**
 * What the session has read so far, for the camera screen (`readSoFar` on frame / skip / check
 * responses). `brand` is the brand the resolver settled on when it ran, else the raw brand text;
 * a typed brand (hint, answer or client-sent text) is `hint`, a brand read off the bottle `read`.
 * `newFields` lists what `after` has that `before` lacked (empty without `before`).
 */
export function summarizeCaptureRead(
  after: CaptureEvidence,
  resolvedBrand: CaptureBrandRef | null,
  before?: CaptureEvidence
): CaptureReadSummary {
  let brand: CaptureReadSummary["brand"] = null;
  if (resolvedBrand) {
    brand = { name: resolvedBrand.name, source: resolvedBrand.source, catalogMatch: resolvedBrand.brandId !== null };
  } else if (after.brand) {
    const typed = after.brandSource === "hint" || after.brandRead?.source === "request_quality";
    brand = { name: after.brand, source: typed ? "hint" : "read", catalogMatch: false };
  }

  const newFields: CaptureReadField[] = [];
  if (before) {
    if (!before.gtin && after.gtin) newFields.push("gtin");
    if (!before.brand && after.brand) newFields.push("brand");
    if (!(before.shadeName || before.shadeNameListed) && (after.shadeName || after.shadeNameListed)) {
      newFields.push("shadeName");
    }
    if (!before.glassHex && after.glassHex) newFields.push("hex");
    if (!before.finish && after.finish) newFields.push("finish");
  }

  return {
    gtin: after.gtin ?? null,
    brand,
    shadeName: after.shadeName ?? null,
    shadeNameListed: after.shadeNameListed ?? null,
    hex: after.glassHex ?? null,
    finish: after.finish ?? null,
    newFields,
  };
}
