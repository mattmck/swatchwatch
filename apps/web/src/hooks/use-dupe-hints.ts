"use client";

import { useEffect, useMemo, useState } from "react";
import type { Polish, PolishDupeHint } from "swatchwatch-shared";
import { getPolishDupeHints } from "@/lib/api";
import { dupeHintShadeIds, fetchDupeHints, keepDupeHints } from "@/lib/dupes";

const NO_HINTS: Record<string, PolishDupeHint> = {};

/**
 * Dupe hints (#265) for the not-owned rows of a list (catalog rows and wishlist), fetched with
 * the batch endpoint — one request per `DUPE_LIMITS.batchMaxShadeIds` rows, never one per row.
 * Failures are swallowed: hints are an enhancement, the list must keep working without them.
 */
export function useDupeHints(polishes: readonly Pick<Polish, "id" | "status">[]): Record<string, PolishDupeHint> {
  const idsKey = useMemo(() => dupeHintShadeIds(polishes).join(","), [polishes]);
  const [fetched, setFetched] = useState<Record<string, PolishDupeHint>>(NO_HINTS);

  useEffect(() => {
    if (!idsKey) return;
    let cancelled = false;
    fetchDupeHints(idsKey.split(","), getPolishDupeHints)
      .then((hints) => {
        if (!cancelled) setFetched(hints);
      })
      .catch(() => {
        // Hints are optional; keep the list usable. Drop the retained hints too, so badges that
        // may no longer be true don't stay on screen when the refetch can't confirm them.
        if (!cancelled) setFetched(NO_HINTS);
      });
    return () => {
      cancelled = true;
    };
  }, [idsKey]);

  // While a refetch is in flight (e.g. after adding a polish from a row) keep the previous hints
  // for rows that are still listed instead of blanking every badge (#330); hints for ids that
  // left the list (previous page) are dropped.
  return useMemo(() => keepDupeHints(fetched, idsKey ? idsKey.split(",") : []), [fetched, idsKey]);
}
