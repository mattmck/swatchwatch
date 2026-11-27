/**
 * "What we've read": the rows the Rapid Add camera screen shows under the bottle prompt from the
 * capture API's `readSoFar` (`CaptureReadSummary`), shared by the web and the Expo app. Pure.
 */
import type { CaptureReadField, CaptureReadSummary } from "../types/capture";

export interface ReadPanelRow {
  field: CaptureReadField;
  label: string;
  /** What was read; null shows "Not read yet". */
  value: string | null;
  /** A short note under the value (where it came from, or what to check). */
  detail?: string;
  /** The lacquer swatch for the color row. */
  hex?: string;
  /** The latest photo added this field. */
  isNew: boolean;
  /** The value came from the bottle and should be checked (a brand that matched no catalog brand). */
  needsCheck?: boolean;
}

/**
 * Rows for the panel under the camera prompt: barcode, brand, shade name, color, finish. A barcode
 * read on this device shows at once, before the server answers.
 */
export function readPanelRows(summary: CaptureReadSummary | null, liveBarcode: string | null): ReadPanelRow[] {
  const isNew = (field: CaptureReadField) => Boolean(summary?.newFields.includes(field));
  const gtin = summary?.gtin ?? liveBarcode ?? null;
  const brand = summary?.brand ?? null;
  const printed = summary?.shadeName ?? null;
  const listed = summary?.shadeNameListed ?? null;

  let brandDetail: string | undefined;
  if (brand) {
    brandDetail = brand.catalogMatch
      ? "Matched in the catalog"
      : brand.source === "hint"
        ? "Your brand (not in the catalog yet)"
        : "Read from the bottle — check it";
  }

  let nameDetail: string | undefined;
  if (listed && printed && listed.toLowerCase() !== printed.toLowerCase()) nameDetail = `Closest catalog name: ${listed}`;
  else if (listed) nameDetail = "Matched to the brand's catalog list";
  else if (printed) nameDetail = "As printed on the bottle";

  return [
    {
      field: "gtin",
      label: "Barcode",
      value: gtin,
      detail: gtin && !summary?.gtin ? "Scanned on this device" : undefined,
      isNew: isNew("gtin"),
    },
    {
      field: "brand",
      label: "Brand",
      value: brand?.name ?? null,
      detail: brandDetail,
      isNew: isNew("brand"),
      needsCheck: Boolean(brand && !brand.catalogMatch && brand.source === "read"),
    },
    { field: "shadeName", label: "Shade name", value: printed ?? listed, detail: nameDetail, isNew: isNew("shadeName") },
    {
      field: "hex",
      label: "Color",
      value: summary?.hex ?? null,
      detail: summary?.hex ? "Measured from the glass" : undefined,
      hex: summary?.hex ?? undefined,
      isNew: isNew("hex"),
    },
    { field: "finish", label: "Finish", value: summary?.finish ?? null, isNew: isNew("finish") },
  ];
}
