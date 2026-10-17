"use client";

import { useEffect, useMemo, useState } from "react";
import type { Polish, PolishDupeHint } from "swatchwatch-shared";
import { getPolishDupeHints } from "@/lib/api";
import { dupeHintShadeIds, fetchDupeHints } from "@/lib/dupes";

const NO_HINTS: Record<string, PolishDupeHint> = {};

/**
 * Dupe hints (#265) for the not-owned rows of a list (catalog rows and wishlist), fetched with
 * the batch endpoint — one request per `DUPE_LIMITS.batchMaxShadeIds` rows, never one per row.
 * Failures are swallowed: hints are an enhancement, the list must keep working without them.
 */
export function useDupeHints(polishes: readonly Pick<Polish, "id" | "status">[]): Record<string, PolishDupeHint> {
  const idsKey = useMemo(() => dupeHintShadeIds(polishes).join(","), [polishes]);
  // Keyed by the id list so hints for a previous page are never shown on the next one.
  const [state, setState] = useState<{ key: string; hints: Record<string, PolishDupeHint> } | null>(null);

  useEffect(() => {
    if (!idsKey) return;
    let cancelled = false;
    fetchDupeHints(idsKey.split(","), getPolishDupeHints)
      .then((hints) => {
        if (!cancelled) setState({ key: idsKey, hints });
      })
      .catch(() => {
        // Hints are optional; keep the list usable.
      });
    return () => {
      cancelled = true;
    };
  }, [idsKey]);

  return state && state.key === idsKey ? state.hints : NO_HINTS;
}
