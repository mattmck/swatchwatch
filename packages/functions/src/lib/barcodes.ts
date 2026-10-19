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
 * barcode field), and any length that is not 8/11/12/13/14, is rejected, so junk never becomes a
 * match key. A wrong GS1 check digit is NOT rejected (a vendor typo or a bad read still names
 * a bottle): the code gets its canonical key with `checkDigitValid: false` and each caller logs it.
 * `barcode_type` records how the code was read.
 *
 * Equivalence classes (one canonical key): UPC-A (12 digits, or 11 when a leading zero was
 * lost) = its 0-prefixed EAN-13 (what iOS reports) = its 00-prefixed GTIN-14 = the UPC-E that
 * expands to it; an EAN-13 = its 0-prefixed GTIN-14.
 *
 * Duplication note: apps/mobile's Expo scanner helper (packages/shared `barcode/gtin.ts`, PR
 * #376) validates codes as printed and has the same check-digit/UPC-E routines; once both
 * land, `hasValidGtinCheckDigit`/`expandUpcE` here can import them from swatchwatch-shared.
 */

export type BarcodeType = "EAN_13" | "UPC_A" | "UPC_E" | "EAN_8" | "GTIN_14";

export interface NormalizedGtin {
  gtin: string;
  barcodeType: BarcodeType;
  /** False when the GS1 check digit is wrong; the code is kept (callers log it). */
  checkDigitValid: boolean;
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

/**
 * Expand an 8-digit UPC-E (number system 0/1 + 6 digits + check) to its 12-digit UPC-A. Returns
 * null when the expansion's check digit is wrong, unless `lenient` (the digit is carried over).
 */
export function expandUpcE(upcE: string, lenient = false): string | null {
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
  return lenient || hasValidGtinCheckDigit(upcA) ? upcA : null;
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

function fromUpcA(upcA: string): NormalizedGtin {
  return { gtin: `0${upcA}`, barcodeType: "UPC_A", checkDigitValid: hasValidGtinCheckDigit(upcA) };
}

function readEightDigits(digits: string, reading: "ean_8" | "upc_e", lenient: boolean): NormalizedGtin | null {
  if (reading === "ean_8") {
    const valid = hasValidGtinCheckDigit(digits);
    return valid || lenient ? { gtin: digits, barcodeType: "EAN_8", checkDigitValid: valid } : null;
  }
  const upcA = expandUpcE(digits, lenient);
  return upcA
    ? { gtin: `0${upcA}`, barcodeType: "UPC_E", checkDigitValid: hasValidGtinCheckDigit(upcA) }
    : null;
}

/**
 * The canonical `barcode.gtin` key for a raw code, or null when it is not a plausible retail
 * barcode (non-numeric, wrong length). `format` is the decoder's format name (`ean_13`, `UPC_E`,
 * …), used to read an 8-digit code as UPC-E rather than EAN-8 and to label `barcodeType`.
 */
export function normalizeGtin(raw: unknown, format?: unknown): NormalizedGtin | null {
  const digits = digitsOf(raw);
  if (!digits) return null;
  const hint = normalizeFormatHint(format);

  switch (digits.length) {
    case 8:
      if (hint === "upc_e") return readEightDigits(digits, "upc_e", true);
      if (hint === "ean_8") return readEightDigits(digits, "ean_8", true);
      // No hint: prefer a reading whose check digit is right; else it is an EAN-8 as printed.
      return (
        readEightDigits(digits, "ean_8", false) ??
        readEightDigits(digits, "upc_e", false) ??
        readEightDigits(digits, "ean_8", true)
      );
    case 11:
      // A UPC-A stored as a number loses its leading zero.
      return fromUpcA(`0${digits}`);
    case 12:
      return fromUpcA(digits);
    case 13: {
      const valid = hasValidGtinCheckDigit(digits);
      return { gtin: digits, barcodeType: hint === "upc_a" && digits[0] === "0" ? "UPC_A" : "EAN_13", checkDigitValid: valid };
    }
    case 14:
      return {
        gtin: digits[0] === "0" ? digits.slice(1) : digits,
        barcodeType: "GTIN_14",
        checkDigitValid: hasValidGtinCheckDigit(digits),
      };
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
      const alt = readEightDigits(digits, reading, false);
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
    if (canonical[0] === "0") {
      spellings.add(canonical.slice(1));
      // A UPC-A whose own leading zero a vendor's spreadsheet dropped.
      if (canonical[1] === "0") spellings.add(canonical.slice(2));
    }
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
  /** GTINs written (or already linked) whose check digit is wrong; callers log them. */
  invalidCheckDigit: string[];
}

interface QueryClient {
  query<R extends Record<string, any> = any>(sql: string, params?: any[]): Promise<{ rows: R[]; rowCount: number | null }>;
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
  const result: ShadeBarcodeUpsertResult = { inserted: 0, alreadyLinked: 0, conflicts: [], skuCreated: false, invalidCheckDigit: [] };
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

  for (const [index, { gtin, barcodeType, checkDigitValid }] of input.gtins.entries()) {
    const inserted = await client.query(
      `INSERT INTO barcode (sku_id, gtin, barcode_type, is_primary, source, external_product_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (gtin) DO NOTHING
       RETURNING true AS inserted`,
      [skuId, gtin, barcodeType, index === 0, input.source, input.externalProductId ?? null]
    );
    if ((inserted.rowCount ?? 0) > 0) {
      result.inserted += 1;
      if (checkDigitValid === false) result.invalidCheckDigit.push(gtin);
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
    return { inserted: 0, alreadyLinked: 0, conflicts: [], skuCreated: false, invalidCheckDigit: [] };
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

/**
 * Remember a scanned GTIN on a shade for one user (`user_shade_barcode`, #21): the capture
 * resolver matches it for that user only, after the shared catalog. Upserts on (user, GTIN), so
 * re-teaching moves the GTIN to the newer shade. Runs inside the caller's transaction.
 */
export async function rememberUserShadeBarcode(
  client: QueryClient,
  input: { userId: number; shadeId: number; gtin: NormalizedGtin; captureSessionId?: number | null }
): Promise<void> {
  await client.query(
    `INSERT INTO user_shade_barcode (user_id, gtin, shade_id, barcode_type, capture_session_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, gtin) DO UPDATE
       SET shade_id = EXCLUDED.shade_id,
           barcode_type = EXCLUDED.barcode_type,
           capture_session_id = EXCLUDED.capture_session_id,
           updated_at = now()`,
    [input.userId, input.gtin.gtin, input.shadeId, input.gtin.barcodeType, input.captureSessionId ?? null]
  );
}
