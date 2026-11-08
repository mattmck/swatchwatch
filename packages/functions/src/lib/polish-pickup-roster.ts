/**
 * Polish Pickup maker roster: which vendors of the shop's `products.json` are already
 * registered `data_source` rows. Pure (no network, no database) so the script and its test share it.
 */

export interface RosterRow {
  vendor: string;
  /** Registered source name the vendor matches, or null. */
  source: string | null;
}

/** A registered source: its name and the optional `metadata.brand`. */
export interface RosterSource {
  name: string;
  brand?: string | null;
}

/** Protocol suffixes stripped from a source name to get its brand key (`PahlishShopify` -> `pahlish`). */
const PROTOCOL_SUFFIXES = ["Shopify", "WooCommerce", "BigCartel", "Feed", "Sitemap"];

/** Lower-cased, non-alphanumerics removed. */
export function rosterKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function stripProtocolSuffix(name: string): string {
  for (const suffix of PROTOCOL_SUFFIXES) {
    if (name.length > suffix.length && name.endsWith(suffix)) return name.slice(0, -suffix.length);
  }
  return name;
}

/**
 * Maps each vendor to the first source whose `metadata.brand`, or whose name without its protocol
 * suffix, equals the vendor after `rosterKey`. `sources` entries are a name or a `RosterSource`.
 */
export function diffRoster(vendors: string[], sources: Array<string | RosterSource>): RosterRow[] {
  const byKey = new Map<string, string>();
  for (const entry of sources) {
    const source: RosterSource = typeof entry === "string" ? { name: entry } : entry;
    const keys = [rosterKey(stripProtocolSuffix(source.name))];
    if (source.brand) keys.push(rosterKey(source.brand));
    for (const key of keys) {
      if (key && !byKey.has(key)) byKey.set(key, source.name);
    }
  }
  return vendors.map((vendor) => ({ vendor, source: byKey.get(rosterKey(vendor)) ?? null }));
}

/**
 * Reads source names and `"brand": "…"` metadata values from the text of `docs/seed_data_sources.sql`.
 * A row starts with `('<Name>',` on its own line; the brand is the first `"brand": "…"` before the next row.
 */
export function parseSeedSources(sql: string): RosterSource[] {
  const sources: RosterSource[] = [];
  const rowStart = /^\s*\(\s*\n\s*'([^']+)',/gm;
  const starts: Array<{ name: string; index: number }> = [];
  for (let match = rowStart.exec(sql); match; match = rowStart.exec(sql)) {
    starts.push({ name: match[1], index: match.index });
  }
  starts.forEach((start, i) => {
    const body = sql.slice(start.index, i + 1 < starts.length ? starts[i + 1].index : sql.length);
    const brand = /"brand"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(body);
    sources.push({ name: start.name, brand: brand ? brand[1] : null });
  });
  return sources;
}
