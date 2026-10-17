import type { CollectionStatsResponse } from "swatchwatch-shared";
import {
  barPercent,
  currencyLabel,
  findSpend,
  formatMoney,
  formatMonthLong,
  formatMonthShort,
  labelledMonths,
} from "@/lib/collection-stats";
import { StatsEmpty, StatsPanel, StatsTable } from "./stats-panel";

/** Spend per month over the last 12 months in one currency, as columns. */
export function SpendByMonthPanel({
  stats,
  currency,
}: {
  stats: CollectionStatsResponse | null;
  currency: string;
}) {
  const group = stats ? findSpend(stats, currency) : undefined;
  const months = group?.byMonth ?? [];
  const windowTotal = months.reduce((sum, m) => sum + Math.round(m.total * 100), 0) / 100;
  const estimated = months.reduce((sum, m) => sum + m.estimatedDateCount, 0);
  const max = months.reduce((top, m) => Math.max(top, m.total), 0);
  const labelled = labelledMonths(months);
  const label = group ? currencyLabel(group.currency) : null;
  const hasMonthly = months.some((m) => m.itemCount > 0);

  return (
    <StatsPanel
      title="Spend by month"
      description={group && label ? `Last 12 months, ${label}` : "Your polish spending over the last year"}
      loading={!stats}
    >
      {stats && !hasMonthly && (
        <StatsEmpty
          message={
            group
              ? "No purchases in the last 12 months in this currency."
              : "Add a purchase price (and date) to your polishes to see monthly spend."
          }
          actionLabel={group ? undefined : "Go to your collection"}
          actionHref="/polishes"
        />
      )}
      {group && hasMonthly && (
        <>
          <p className="mb-3 text-sm text-muted-foreground">
            <span className="text-2xl font-semibold text-foreground">{formatMoney(windowTotal, group.currency)}</span>{" "}
            in the last 12 months
          </p>
          <div aria-hidden className="flex h-40 items-end gap-[2px] border-b border-border">
            {months.map((m) => {
              const value = formatMoney(m.total, group.currency);
              return (
                <div
                  key={m.month}
                  className="group relative flex h-full flex-1 flex-col items-center justify-end"
                  title={`${formatMonthLong(m.month)}: ${value} · ${m.itemCount} ${m.itemCount === 1 ? "polish" : "polishes"}`}
                >
                  {labelled.has(m.month) && (
                    <span className="mb-1 whitespace-nowrap text-[10px] tabular-nums text-muted-foreground">
                      {value}
                    </span>
                  )}
                  <span
                    className="w-full max-w-6 rounded-t-[4px] bg-brand-purple transition-opacity group-hover:opacity-80"
                    style={{ height: `${barPercent(m.total, max)}%` }}
                  />
                </div>
              );
            })}
          </div>
          <div aria-hidden className="mt-1 flex gap-[2px]">
            {months.map((m, i) => (
              <span
                key={m.month}
                className={`flex-1 text-center text-[10px] text-muted-foreground ${i % 2 === 1 ? "hidden sm:block" : ""}`}
              >
                {formatMonthShort(m.month)}
              </span>
            ))}
          </div>
          {estimated > 0 && (
            <p className="mt-3 text-xs text-muted-foreground">
              {estimated} {estimated === 1 ? "purchase has" : "purchases have"} no purchase date and{" "}
              {estimated === 1 ? "is" : "are"} counted in the month {estimated === 1 ? "it was" : "they were"} added.
            </p>
          )}
          <StatsTable
            caption={`Spend by month, ${label}`}
            columns={["Month", "Spend", "Polishes"]}
            rows={months.map((m) => [formatMonthLong(m.month), formatMoney(m.total, group.currency), m.itemCount])}
          />
        </>
      )}
    </StatsPanel>
  );
}
