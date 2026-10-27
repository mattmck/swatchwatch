/**
 * Admin view of the connector products behind a catalog shade (`shade_source_product` →
 * `external_product`): every vendor listing that was materialized into the shade, with the raw
 * payload the connector fetched and the normalized record ingestion read. Admin-only; never in a
 * user-facing response.
 */
export interface ShadeSourceProduct {
  externalProductId: string;
  /** `data_source.name`, e.g. `HoloTacoShopify`, `MakeupAPI`. */
  source: string;
  sourceEnabled: boolean;
  externalId: string;
  gtin: string | null;
  /** `normalized_json.productUrl`, unvalidated (may be dead or rejected as a buy link). */
  productUrl: string | null;
  fetchedAt: string;
  firstSeenAt: string;
  lastSeenAt: string;
  rawJson: unknown;
  normalizedJson: unknown;
}

/** `GET /api/shades-admin/{id}/source-products`. */
export interface ShadeSourceProductsResponse {
  shadeId: string;
  products: ShadeSourceProduct[];
}
