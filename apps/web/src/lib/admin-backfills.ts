/**
 * Totals for the admin console's Backfills tab. Every backfill endpoint answers one keyset batch
 * with a flat report (counters, per-key count maps, lists of findings and the next cursor); the
 * tab loops over batches and folds each report into running totals with `mergeBackfillTotals`.
 */

export type BackfillReport = Record<string, unknown>;

/** Findings kept per list across a whole run; the rest are counted, not kept. */
export const MAX_BACKFILL_LIST_ITEMS = 200;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCountMap(value: Record<string, unknown>): value is Record<string, number> {
  return Object.values(value).every((entry) => typeof entry === "number");
}

/**
 * Folds one batch report into the totals (a new object; neither input changes):
 * numbers are summed, count maps (`{ MakeupAPI: 3 }`) are summed per key, other objects are
 * merged key by key (later batches win), and lists are concatenated up to
 * `MAX_BACKFILL_LIST_ITEMS` with their full length kept in `<key>Count`. Keys in `skip` (the
 * cursor, `dryRun`) and booleans/strings/nulls are left out.
 */
export function mergeBackfillTotals(
  totals: BackfillReport,
  batch: BackfillReport,
  skip: readonly string[] = []
): BackfillReport {
  const next: BackfillReport = { ...totals };
  for (const [key, value] of Object.entries(batch)) {
    if (skip.includes(key)) continue;
    const current = next[key];
    if (typeof value === "number") {
      next[key] = (typeof current === "number" ? current : 0) + value;
    } else if (Array.isArray(value)) {
      const kept = Array.isArray(current) ? current : [];
      next[key] = [...kept, ...value].slice(0, MAX_BACKFILL_LIST_ITEMS);
      const countKey = `${key}Count`;
      next[countKey] = (typeof next[countKey] === "number" ? (next[countKey] as number) : 0) + value.length;
    } else if (isPlainObject(value)) {
      const base = isPlainObject(current) ? current : {};
      if (isCountMap(value) && isCountMap(base)) {
        const summed: Record<string, number> = { ...base };
        for (const [mapKey, count] of Object.entries(value)) summed[mapKey] = (summed[mapKey] ?? 0) + count;
        next[key] = summed;
      } else {
        next[key] = { ...base, ...value };
      }
    }
  }
  return next;
}

/** Reads a keyset cursor from a batch report: a non-negative integer, or null when finished. */
export function readBackfillCursor(batch: BackfillReport, key: string): number | null {
  const value = batch[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Splits the comma-separated data source field into names; empty → null (every source). */
export function parseSourceNames(text: string): string[] | null {
  const names = text
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  return names.length > 0 ? [...new Set(names)] : null;
}
