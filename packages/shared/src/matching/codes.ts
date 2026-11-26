import { hasValidGtinCheckDigit } from "../barcode/gtin";
import { normalizeMatchText } from "./normalize";

/**
 * Whether a shade alias is a vendor code (`NLF008`, `2000344`) rather than a name: no spaces,
 * at least one digit and at least 4 characters. Printed on the bottle it names the shade
 * exactly, so it is matched by equality, never by similarity.
 */
export function isVendorCodeAlias(alias: string): boolean {
  return !/\s/.test(alias.trim()) && /\d/.test(alias) && alias.length >= 4;
}

/** An entry of a brand's match list that may carry vendor-code aliases (other aliases are ignored here). */
export interface VendorCodeSource {
  shadeId: number;
  aliases?: readonly string[];
}

/** Normalised vendor code → ids of the shades that have it. */
export type VendorCodeIndex = ReadonlyMap<string, readonly number[]>;

export function buildVendorCodeIndex(entries: readonly VendorCodeSource[]): VendorCodeIndex {
  const index = new Map<string, number[]>();
  for (const entry of entries) {
    for (const alias of entry.aliases ?? []) {
      if (!isVendorCodeAlias(alias)) continue;
      const key = normalizeMatchText(alias);
      if (key === "") continue;
      const ids = index.get(key);
      if (!ids) index.set(key, [entry.shadeId]);
      else if (!ids.includes(entry.shadeId)) ids.push(entry.shadeId);
    }
  }
  return index;
}

/** Ids (ascending) of the shades whose vendor code equals one of the tokens after normalisation. */
export function findVendorCodeShades(tokens: Iterable<string>, index: VendorCodeIndex): number[] {
  const hits = new Set<number>();
  for (const token of tokens) {
    const ids = index.get(normalizeMatchText(token));
    if (ids) for (const id of ids) hits.add(id);
  }
  return [...hits].sort((a, b) => a - b);
}

/**
 * Printed retail barcodes among the tokens: the digits of a token (everything else stripped)
 * when they are 12 (UPC-A) or 13 (EAN-13) long with a valid GS1 check digit. Distinct, sorted.
 */
export function findPrintedGtins(tokens: Iterable<string>): string[] {
  const found = new Set<string>();
  for (const token of tokens) {
    const digits = token.replace(/\D/g, "");
    if ((digits.length === 12 || digits.length === 13) && hasValidGtinCheckDigit(digits)) found.add(digits);
  }
  return [...found].sort();
}
