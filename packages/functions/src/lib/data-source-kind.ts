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
