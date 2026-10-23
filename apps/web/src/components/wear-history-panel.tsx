"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CalendarHeart } from "lucide-react";
import type { Manicure } from "swatchwatch-shared";
import { WEAR_HISTORY_PREVIEW_COUNT, buildWearHistory, wearHistoryTitle } from "swatchwatch-shared";
import { listManicures } from "@/lib/api";
import { MANICURE_ROLE_LABELS, formatWornOn, manicurePolishHex, toLocalIsoDate } from "@/lib/mani-log";
import { ColorDot } from "@/components/color-dot";
import { PrivateImage } from "@/components/private-image";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface WearHistoryPanelProps {
  shadeId: string;
  /** Changes whenever the wear stats do, so a one-tap log or undo refreshes the list. */
  wearCount: number;
  /** The one-tap "Log today's mani" control, shown in the empty state. */
  logButton?: React.ReactNode;
}

/** "Worn N times" on the polish detail page: the newest manis this shade appears in (read only). */
export function WearHistoryPanel({ shadeId, wearCount, logButton }: WearHistoryPanelProps) {
  const [state, setState] = useState<{ manicures: Manicure[]; total: number } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listManicures({ shadeId, pageSize: WEAR_HISTORY_PREVIEW_COUNT })
      .then((response) => {
        if (cancelled) return;
        setFailed(false);
        setState({ manicures: response.manicures, total: response.total });
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [shadeId, wearCount]);

  if (failed || !state) return null;

  const todayIso = toLocalIsoDate(new Date());
  const entries = buildWearHistory(state.manicures, shadeId);

  return (
    <Card data-testid="wear-history">
      <CardHeader>
        <CardTitle>
          {wearHistoryTitle(state.total)}
        </CardTitle>
        <CardDescription>
          {state.total === 0 ? "Log a mani to start this polish's history." : "The manis this polish was part of, newest first."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {entries.length === 0 && logButton}
        {entries.length > 0 && (
          <ul className="space-y-2">
            {entries.map((entry) => (
              <li key={entry.manicureId} className="flex items-center gap-3 rounded-lg border p-2">
                {entry.photoUrl && (
                  <PrivateImage
                    src={entry.photoUrl}
                    alt={`Mani from ${entry.wornOn}`}
                    className="size-12 shrink-0 rounded-md border object-cover"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {formatWornOn(entry.wornOn, todayIso)}
                    {entry.role && (
                      <span className="font-normal text-muted-foreground"> · {MANICURE_ROLE_LABELS[entry.role]}</span>
                    )}
                  </p>
                  {entry.others.length > 0 && (
                    <ul className="mt-1 flex flex-wrap gap-1" aria-label="Other polishes in this mani">
                      {entry.others.map((other) => (
                        <li key={`${other.shadeId}-${other.role}`}>
                          <span title={`${other.brand} ${other.name} · ${MANICURE_ROLE_LABELS[other.role]}`}>
                            <ColorDot hex={manicurePolishHex(other)} size="sm" />
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {state.total > 0 && (
          <Link
            href={`/manis?shade=${shadeId}`}
            className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
          >
            <CalendarHeart className="size-4" />
            {state.total > entries.length ? `Show all ${state.total}` : "Open in mani log"}
          </Link>
        )}
      </CardContent>
    </Card>
  );
}
