import {
  DUPE_LIMITS,
  type DupeGrade,
  type FinishCompatibility,
  type Polish,
  type PolishDupe,
  type PolishDupeHint,
  type PolishDupesBatchResponse,
  type PolishDupesResponse,
  resolveProductCategory,
} from "swatchwatch-shared";
import { detailHref } from "./detail-href";

/**
 * Client helpers for the dupe finder (#265). Pure (the API calls are injected), so the
 * add-guard (#266) and the Rapid Add verdict card (#21) can reuse them.
 *
 * API: `getPolishDupes(id)` / `getPolishDupeHints(ids)` in `./api`. Hook: `useDupeHints` in
 * `@/hooks/use-dupe-hints`.
 */

export const DUPE_GRADE_META: Record<DupeGrade, { label: string; badgeClassName: string; description: string }> = {
  high: {
    label: "Close dupe",
    badgeClassName:
      "border border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200",
    description: "Reads as the same color",
  },
  medium: {
    label: "Near dupe",
    badgeClassName:
      "border border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-200",
    description: "Same color family, slightly different shade or finish",
  },
};

export const FINISH_COMPATIBILITY_LABELS: Record<FinishCompatibility, string> = {
  same: "Same finish",
  compatible: "Similar finish",
  different: "Different finish",
  unknown: "Finish unknown",
};

/**
 * Ids of the rows that should show a dupe hint: anything the user does not own yet that can have
 * dupes at all (color polishes and toppers; coats, treatments and accessories never do, #349).
 */
export function dupeHintShadeIds(
  polishes: readonly (Pick<Polish, "id" | "status"> & Partial<Pick<Polish, "productCategory">>)[]
): string[] {
  const ids: string[] = [];
  for (const polish of polishes) {
    if (polish.status === "owned") continue;
    const category = resolveProductCategory(polish.productCategory);
    if (category !== "color" && category !== "topper") continue;
    if (!ids.includes(polish.id)) ids.push(polish.id);
  }
  return ids;
}

/** Split ids into request-sized chunks (default `DUPE_LIMITS.batchMaxShadeIds`). */
export function chunkShadeIds(ids: readonly string[], size: number = DUPE_LIMITS.batchMaxShadeIds): string[][] {
  const chunkSize = Math.max(1, Math.floor(size));
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    chunks.push(ids.slice(i, i + chunkSize));
  }
  return chunks;
}

/**
 * Fetch dupe hints for any number of shade ids: chunks to the batch cap, runs the chunks in
 * parallel and merges the results (keyed by shade id; ids the API omitted stay absent).
 */
export async function fetchDupeHints(
  shadeIds: readonly string[],
  fetchBatch: (ids: string[]) => Promise<PolishDupesBatchResponse>
): Promise<Record<string, PolishDupeHint>> {
  const unique = Array.from(new Set(shadeIds));
  if (unique.length === 0) return {};
  const responses = await Promise.all(chunkShadeIds(unique).map((chunk) => fetchBatch(chunk)));
  return Object.assign({}, ...responses.map((response) => response.results)) as Record<string, PolishDupeHint>;
}

/**
 * Hints from an earlier fetch that are still worth showing while a refetch for `shadeIds` is in
 * flight (#330): only entries for ids still in the list, so the badges of rows that stay put do
 * not blink out when another row changes, while hints for rows that left the page are dropped.
 * Returns `previous` itself when nothing needs dropping (keeps the reference stable).
 */
export function keepDupeHints(
  previous: Readonly<Record<string, PolishDupeHint>>,
  shadeIds: readonly string[]
): Record<string, PolishDupeHint> {
  const wanted = new Set(shadeIds);
  const keys = Object.keys(previous);
  if (keys.every((id) => wanted.has(id))) return previous as Record<string, PolishDupeHint>;
  const kept: Record<string, PolishDupeHint> = {};
  for (const id of keys) {
    if (wanted.has(id)) kept[id] = previous[id];
  }
  return kept;
}

/** Short row hint ("Dupe owned" / "Near dupe owned"), or null when there is no owned dupe. */
export function dupeHintLabel(hint: PolishDupeHint | null | undefined): string | null {
  if (!hint?.best) return null;
  return hint.best.grade === "high" ? "Dupe owned" : "Near dupe owned";
}

/** Tooltip text for a row hint, naming the best owned dupe. */
export function dupeHintTitle(hint: PolishDupeHint | null | undefined): string | null {
  if (!hint?.best) return null;
  const { best } = hint;
  const others = hint.dupeCount - 1;
  const suffix = others > 0 ? ` (+${others} more)` : "";
  return `You own ${best.brand} ${best.name} — ${DUPE_GRADE_META[best.grade].label.toLowerCase()}, ${FINISH_COMPATIBILITY_LABELS[best.finishCompatibility].toLowerCase()}${suffix}`;
}

/** Detail-page callout headline, e.g. "You own 2 close dupes"; null when there are none. */
export function dupeCalloutText(response: Pick<PolishDupesResponse, "dupeCount" | "highCount"> | null | undefined): string | null {
  if (!response || response.dupeCount <= 0) return null;
  const { dupeCount, highCount } = response;
  if (highCount === dupeCount) {
    return `You own ${dupeCount} close ${dupeCount === 1 ? "dupe" : "dupes"}`;
  }
  if (highCount === 0) {
    return `You own ${dupeCount} near ${dupeCount === 1 ? "dupe" : "dupes"}`;
  }
  return `You own ${dupeCount} possible dupes (${highCount} close)`;
}

/**
 * Verdict shared by the add-guard and the Rapid Add card: `dupe-owned` when the best owned
 * dupe is HIGH, `near-dupe-owned` for MEDIUM, `none` otherwise.
 */
export type DupeVerdictKind = "dupe-owned" | "near-dupe-owned" | "none";

export function dupeVerdict(
  source: { best: PolishDupe | null } | { dupes: PolishDupe[] } | null | undefined
): { kind: DupeVerdictKind; best: PolishDupe | null } {
  if (!source) return { kind: "none", best: null };
  const best = "best" in source ? source.best : (source.dupes[0] ?? null);
  if (!best) return { kind: "none", best: null };
  return { kind: best.grade === "high" ? "dupe-owned" : "near-dupe-owned", best };
}

/** Detail-page link for a dupe; `returnTo` defaults to the current page (see `detailHref`, #348). */
export function dupeHref(dupe: Pick<PolishDupe, "shadeId">, returnTo?: string | null): string {
  return detailHref(dupe.shadeId, returnTo);
}
