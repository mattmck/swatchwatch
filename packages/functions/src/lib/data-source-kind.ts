/**
 * Kind of a `data_source`, from its `metadata.kind`. A retailer (e.g. Polish Pickup) resells
 * other brands' polishes: its listings are extra buy links but never override a brand store's
 * data. Every other source (no `kind`, or any other value) is a brand store.
 */
export type DataSourceKind = "brand_store" | "retailer";

export function sourceKindFromMetadata(metadata: unknown): DataSourceKind {
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    if ((metadata as { kind?: unknown }).kind === "retailer") return "retailer";
  }
  return "brand_store";
}

export interface ListingWritePlanInput {
  sourceKind: DataSourceKind;
  /** This listing created the shade row. */
  shadeCreated: boolean;
  /** `shade.catalog_authority` before this listing (ignored when `shadeCreated`). */
  shadeAuthority: DataSourceKind;
  /** The shade already has a primary or gallery image from a brand-store source. */
  shadeHasBrandStoreImages: boolean;
  shadeHasDetectedHex: boolean;
}

export interface ListingWritePlan {
  /** Apply the connector's rule product category. */
  writeCategory: boolean;
  /** Link this listing's images as swatches (and prune its stale gallery). */
  linkGallery: boolean;
  /** Run AI hex detection for this listing. */
  runDetection: boolean;
  /** A brand store replaces what a retailer wrote: finishes, colors, retailer swatches. */
  takeOver: boolean;
  /** New `shade.catalog_authority`, or null to leave it. */
  setAuthority: DataSourceKind | null;
}

/**
 * Which catalog fields a listing may write. A retailer never overrides an existing shade (it
 * only fills images and a detected hex that are missing); a brand store always writes, and
 * takes over a shade a retailer created.
 */
export function planListingWrites(input: ListingWritePlanInput): ListingWritePlan {
  if (input.shadeCreated) {
    return {
      writeCategory: true,
      linkGallery: true,
      runDetection: true,
      takeOver: false,
      setAuthority: input.sourceKind,
    };
  }
  if (input.sourceKind === "brand_store") {
    const takeOver = input.shadeAuthority === "retailer";
    return {
      writeCategory: true,
      linkGallery: true,
      runDetection: true,
      takeOver,
      setAuthority: takeOver ? "brand_store" : null,
    };
  }
  return {
    writeCategory: false,
    linkGallery: !input.shadeHasBrandStoreImages,
    runDetection: !input.shadeHasDetectedHex,
    takeOver: false,
    setAuthority: null,
  };
}
