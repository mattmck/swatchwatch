"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CollectionStatsResponse } from "swatchwatch-shared";
import { POLISH_STATUSES } from "swatchwatch-shared";
import { getCollectionStats } from "@/lib/api";
import { currencyKey, currencyLabel, currencyOptions } from "@/lib/collection-stats";
import { POLISH_STATUS_LABELS } from "@/lib/inventory-status";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SpendByBrandPanel } from "./spend-by-brand-panel";
import { SpendByMonthPanel } from "./spend-by-month-panel";
import { WornVsWaitingPanel } from "./worn-vs-waiting-panel";
import { MostWornPanel } from "./most-worn-panel";
import { CostPerWearPanel } from "./cost-per-wear-panel";

/**
 * Dashboard "Collection stats" section (#271). Self-contained: loads
 * `GET /api/stats/collection` once and renders the stats panels, with one currency picker for
 * every money panel (amounts are never combined across currencies).
 */
export function CollectionStatsSection({ className }: { className?: string }) {
  const [stats, setStats] = useState<CollectionStatsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedCurrency, setSelectedCurrency] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setStats(null);
    try {
      setStats(await getCollectionStats());
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load collection stats");
    }
  }, []);

  useEffect(() => {
    let active = true;
    getCollectionStats()
      .then((response) => {
        if (active) setStats(response);
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : "Failed to load collection stats");
      });
    return () => {
      active = false;
    };
  }, []);

  const currencies = useMemo(() => (stats ? currencyOptions(stats) : []), [stats]);
  const currency =
    selectedCurrency !== null && currencies.some((c) => currencyKey(c) === selectedCurrency)
      ? selectedCurrency
      : currencyKey(currencies[0] ?? null);

  return (
    <section aria-labelledby="collection-stats-heading" className={cn("space-y-4", className)}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="collection-stats-heading" className="text-xl font-semibold">
            Collection stats
          </h2>
          {stats && (
            <p className="text-sm text-muted-foreground">
              {POLISH_STATUSES.map((status) => `${stats.totals.byStatus[status]} ${POLISH_STATUS_LABELS[status].toLowerCase()}`).join(" · ")}
            </p>
          )}
        </div>
        {currencies.length > 1 && (
          <div role="group" aria-label="Currency" className="flex flex-wrap gap-1">
            {currencies.map((c) => {
              const key = currencyKey(c);
              const active = key === currency;
              return (
                <Button
                  key={key}
                  type="button"
                  size="sm"
                  variant={active ? "default" : "outline"}
                  aria-pressed={active}
                  onClick={() => setSelectedCurrency(key)}
                >
                  {currencyLabel(c)}
                </Button>
              );
            })}
          </div>
        )}
      </div>

      {error ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-destructive/40 p-4 text-sm">
          <span className="text-destructive">Couldn&apos;t load collection stats: {error}</span>
          <Button type="button" size="sm" variant="outline" onClick={load}>
            Retry
          </Button>
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          <SpendByBrandPanel stats={stats} currency={currency} />
          <SpendByMonthPanel stats={stats} currency={currency} />
          <WornVsWaitingPanel stats={stats} />
          <CostPerWearPanel stats={stats} currency={currency} />
          <MostWornPanel stats={stats} />
        </div>
      )}
    </section>
  );
}
