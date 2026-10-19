/**
 * Retail barcodes (GTINs) for the capture resolver and ingestion (#21, #325).
 *
 * Canonical key: `barcode.gtin` stores every code in one spelling so a bottle matches however
 * it was printed, scanned or typed into a vendor's product data:
 * - UPC-A (12 digits) → its EAN-13 form (leading 0), which is what scanners report as EAN-13;
 * - UPC-E (8 digits) → expanded to UPC-A, then the EAN-13 form;
 * - GTIN-14 with packaging indicator 0 → the 13-digit form (other indicators stay 14 digits);
 * - EAN-8 and EAN-13 as they are.
 * Only spaces and hyphens are stripped; anything else non-numeric (a SKU typed into Shopify's
 * barcode field) and every code with a wrong GS1 check digit are rejected, so junk never
 * becomes a match key. `barcode_type` records how the code was read.
 */

export type BarcodeType = "EAN_13" | "UPC_A" | "UPC_E" | "EAN_8" | "GTIN_14";

export interface NormalizedGtin {
  gtin: string;
  barcodeType: BarcodeType;
}

/** GS1 mod-10 check digit validation for GTIN-8/12/13/14. */
export function hasValidGtinCheckDigit(digits: string): boolean {
  if (!/^\d+$/.test(digits) || ![8, 12, 13, 14].includes(digits.length)) return false;
  const body = digits.slice(0, -1);
  let sum = 0;
  for (let i = 0; i < body.length; i += 1) {
    // Weights alternate 3,1,3,… starting from the digit next to the check digit.
    const digit = body.charCodeAt(body.length - 1 - i) - 48;
    sum += i % 2 === 0 ? digit * 3 : digit;
  }
  return (10 - (sum % 10)) % 10 === digits.charCodeAt(digits.length - 1) - 48;
}

/** Expand an 8-digit UPC-E (number system 0/1 + 6 digits + check) to its 12-digit UPC-A. */
export function expandUpcE(upcE: string): string | null {
  if (!/^[01]\d{7}$/.test(upcE)) return null;
  const ns = upcE[0];
  const d = upcE.slice(1, 7);
  const check = upcE[7];
  const last = d[5];
  let body: string;
  if (last === "0" || last === "1" || last === "2") {
    body = `${d[0]}${d[1]}${last}0000${d[2]}${d[3]}${d[4]}`;
  } else if (last === "3") {
    body = `${d[0]}${d[1]}${d[2]}00000${d[3]}${d[4]}`;
  } else if (last === "4") {
    body = `${d[0]}${d[1]}${d[2]}${d[3]}00000${d[4]}`;
  } else {
    body = `${d[0]}${d[1]}${d[2]}${d[3]}${d[4]}0000${last}`;
  }
  const upcA = `${ns}${body}${check}`;
  return hasValidGtinCheckDigit(upcA) ? upcA : null;
}

type FormatHint = "ean_13" | "upc_a" | "upc_e" | "ean_8" | null;

function normalizeFormatHint(format: unknown): FormatHint {
  if (typeof format !== "string") return null;
  switch (format.trim().toLowerCase().replace(/[^a-z0-9]/g, "")) {
    case "ean13":
      return "ean_13";
    case "upca":
      return "upc_a";
    case "upce":
      return "upc_e";
    case "ean8":
      return "ean_8";
    default:
      return null;
  }
}

function digitsOf(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const digits = raw.replace(/[\s-]/g, "");
  if (!/^\d+$/.test(digits) || /^0+$/.test(digits)) return null;
  return digits;
}

function fromUpcA(upcA: string, barcodeType: BarcodeType): NormalizedGtin | null {
  return hasValidGtinCheckDigit(upcA) ? { gtin: `0${upcA}`, barcodeType } : null;
}

function readEightDigits(digits: string, reading: "ean_8" | "upc_e"): NormalizedGtin | null {
  if (reading === "ean_8") {
    return hasValidGtinCheckDigit(digits) ? { gtin: digits, barcodeType: "EAN_8" } : null;
  }
  const upcA = expandUpcE(digits);
  return upcA ? { gtin: `0${upcA}`, barcodeType: "UPC_E" } : null;
}

/**
 * The canonical `barcode.gtin` key for a raw code, or null when it is not a valid retail
 * barcode. `format` is the decoder's format name (`ean_13`, `UPC_E`, …), used to read an
 * 8-digit code as UPC-E rather than EAN-8 and to label `barcodeType`.
 */
export function normalizeGtin(raw: unknown, format?: unknown): NormalizedGtin | null {
  const digits = digitsOf(raw);
  if (!digits) return null;
  const hint = normalizeFormatHint(format);

  switch (digits.length) {
    case 8:
      if (hint === "upc_e") return readEightDigits(digits, "upc_e");
      if (hint === "ean_8") return readEightDigits(digits, "ean_8");
      return readEightDigits(digits, "ean_8") ?? readEightDigits(digits, "upc_e");
    case 11:
      // A UPC-A stored as a number loses its leading zero.
      return fromUpcA(`0${digits}`, "UPC_A");
    case 12:
      return fromUpcA(digits, "UPC_A");
    case 13:
      if (!hasValidGtinCheckDigit(digits)) return null;
      return { gtin: digits, barcodeType: hint === "upc_a" && digits[0] === "0" ? "UPC_A" : "EAN_13" };
    case 14:
      if (!hasValidGtinCheckDigit(digits)) return null;
      return { gtin: digits[0] === "0" ? digits.slice(1) : digits, barcodeType: "GTIN_14" };
    default:
      return null;
  }
}

/**
 * Canonical keys to look a scanned code up by. Usually one; an 8-digit code without a
 * format hint that is valid both as EAN-8 and as UPC-E yields both readings.
 */
export function gtinLookupKeys(raw: unknown, format?: unknown): string[] {
  const keys = new Set<string>();
  const primary = normalizeGtin(raw, format);
  if (primary) keys.add(primary.gtin);
  const digits = digitsOf(raw);
  if (digits?.length === 8 && !normalizeFormatHint(format)) {
    for (const reading of ["ean_8", "upc_e"] as const) {
      const alt = readEightDigits(digits, reading);
      if (alt) keys.add(alt.gtin);
    }
  }
  return [...keys];
}

/**
 * Every spelling a vendor may have stored a canonical code under (12-digit UPC-A,
 * 13-digit EAN, 14-digit GTIN), for matching the raw `external_product.gtin` column.
 */
export function gtinSpellings(canonical: string): string[] {
  const spellings = new Set<string>([canonical]);
  if (canonical.length === 13) {
    spellings.add(`0${canonical}`);
    if (canonical[0] === "0") spellings.add(canonical.slice(1));
  } else if (canonical.length === 8) {
    spellings.add(`000000${canonical}`);
  }
  return [...spellings];
}

/** The product's GTIN, then each variant barcode (`normalized.variants[].barcode`), deduped. */
export function collectProductGtins(record: {
  gtin?: string | null;
  normalized?: unknown;
}): NormalizedGtin[] {
  const out: NormalizedGtin[] = [];
  const seen = new Set<string>();
  const add = (raw: unknown) => {
    const normalized = normalizeGtin(raw);
    if (normalized && !seen.has(normalized.gtin)) {
      seen.add(normalized.gtin);
      out.push(normalized);
    }
  };
  add(record.gtin);
  const normalized = record.normalized;
  const variants =
    normalized && typeof normalized === "object" ? (normalized as { variants?: unknown }).variants : undefined;
  if (Array.isArray(variants)) {
    for (const variant of variants) {
      if (variant && typeof variant === "object") add((variant as { barcode?: unknown }).barcode);
    }
  }
  return out;
}

/** Who wrote a `barcode` row (`barcode.source`). */
export type BarcodeSource = "ingestion" | "backfill" | "admin";

export interface BarcodeConflict {
  gtin: string;
  /** The shade that already owns the GTIN (and keeps it). */
  existingShadeId: number;
}

export interface ShadeBarcodeUpsertResult {
  inserted: number;
  /** GTINs already linked to this shade. */
  alreadyLinked: number;
  /** GTINs another shade claimed first; skipped, for the caller to log. */
  conflicts: BarcodeConflict[];
  skuCreated: boolean;
}

interface QueryClient {
  query<R = any>(sql: string, params?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
}

/**
 * Link catalog GTINs to a shade: `barcode` rows hang off a SKU, so the shade's first SKU is
 * reused (or one is created from the shade). Conflict rule: a GTIN belongs to one shade
 * (`barcode.gtin` is UNIQUE) and the first shade to claim it keeps it; a claim by another
 * shade is returned in `conflicts` and nothing is overwritten. Runs inside the caller's
 * transaction.
 */
export async function upsertShadeBarcodes(
  client: QueryClient,
  input: {
    shadeId: number;
    gtins: readonly NormalizedGtin[];
    source: BarcodeSource;
    externalProductId?: number | null;
  }
): Promise<ShadeBarcodeUpsertResult> {
  const result: ShadeBarcodeUpsertResult = { inserted: 0, alreadyLinked: 0, conflicts: [], skuCreated: false };
  if (input.gtins.length === 0 || !Number.isSafeInteger(input.shadeId)) return result;

  const existingSku = await client.query<{ skuId: number }>(
    `SELECT sku_id AS "skuId" FROM sku WHERE shade_id = $1 ORDER BY sku_id LIMIT 1`,
    [input.shadeId]
  );
  let skuId = existingSku.rows[0]?.skuId;
  if (skuId === undefined) {
    const createdSku = await client.query<{ skuId: number }>(
      `INSERT INTO sku (brand_id, product_line_id, shade_id, product_name)
       SELECT brand_id, product_line_id, shade_id, shade_name_canonical
       FROM shade
       WHERE shade_id = $1
       RETURNING sku_id AS "skuId"`,
      [input.shadeId]
    );
    skuId = createdSku.rows[0]?.skuId;
    if (skuId === undefined) return result;
    result.skuCreated = true;
  }

  for (const [index, { gtin, barcodeType }] of input.gtins.entries()) {
    const inserted = await client.query(
      `INSERT INTO barcode (sku_id, gtin, barcode_type, is_primary, source, external_product_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (gtin) DO NOTHING
       RETURNING true AS inserted`,
      [skuId, gtin, barcodeType, index === 0, input.source, input.externalProductId ?? null]
    );
    if ((inserted.rowCount ?? 0) > 0) {
      result.inserted += 1;
      continue;
    }
    const owner = await client.query<{ shadeId: number | string | null }>(
      `SELECT s.shade_id AS "shadeId" FROM barcode b JOIN sku s ON s.sku_id = b.sku_id WHERE b.gtin = $1`,
      [gtin]
    );
    const ownerShadeId = owner.rows[0]?.shadeId;
    if (ownerShadeId !== undefined && ownerShadeId !== null && Number(ownerShadeId) === input.shadeId) {
      result.alreadyLinked += 1;
    } else {
      result.conflicts.push({ gtin, existingShadeId: Number(ownerShadeId ?? NaN) });
    }
  }
  return result;
}

/**
 * Ingestion step: link a connector product's GTIN and variant barcodes to the shade it was
 * materialized into, with the product as provenance. No SQL for a product without a valid
 * barcode. Conflicts (GTIN owned by another shade) are returned for the job log.
 */
export async function materializeProductBarcodes(
  client: QueryClient,
  input: {
    shadeId: number;
    dataSourceId: number;
    record: { externalId?: string | null; gtin?: string | null; normalized?: unknown };
  }
): Promise<ShadeBarcodeUpsertResult> {
  const gtins = collectProductGtins(input.record);
  if (gtins.length === 0) {
    return { inserted: 0, alreadyLinked: 0, conflicts: [], skuCreated: false };
  }
  const externalId = input.record.externalId?.trim();
  let externalProductId: number | null = null;
  if (externalId) {
    const product = await client.query<{ externalProductId: number | string }>(
      `SELECT external_product_id AS "externalProductId"
       FROM external_product
       WHERE data_source_id = $1 AND external_id = $2`,
      [input.dataSourceId, externalId]
    );
    const id = product.rows[0]?.externalProductId;
    externalProductId = id === undefined ? null : Number(id);
  }
  return upsertShadeBarcodes(client, {
    shadeId: input.shadeId,
    gtins,
    source: "ingestion",
    externalProductId,
  });
}
