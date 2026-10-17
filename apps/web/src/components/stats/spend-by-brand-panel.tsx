import type { CollectionStatsResponse } from "swatchwatch-shared";
import { barPercent, currencyLabel, findSpend, formatMoney } from "@/lib/collection-stats";
import { StatsEmpty, StatsPanel, StatsTable } from "./stats-panel";

/** All-time spend per brand in one currency (top brands + "Other"), as horizontal bars. */
export function SpendByBrandPanel({
  stats,
  currency,
}: {
  /** null while loading. */
  stats: CollectionStatsResponse | null;
  /** `currencyKey` of the selected currency. */
  currency: string;
}) {
  const group = stats ? findSpend(stats, currency) : undefined;
  const label = group ? currencyLabel(group.currency) : null;

  return (
    <StatsPanel
      title="Spend by brand"
      description={group && label ? `All-time, ${label}` : "Where your polish money goes"}
      loading={!stats}
    >
      {stats && !group && (
        <StatsEmpty
          message={
            stats.spend.currencies.length === 0
              ? "Add a purchase price to your polishes to see spend by brand."
              : "No purchases recorded in this currency."
          }
          actionLabel={stats.spend.currencies.length === 0 ? "Go to your collection" : undefined}
          actionHref="/polishes"
        />
      )}
      {group && (
        <>
          <p className="mb-3 text-sm text-muted-foreground">
            <span className="text-2xl font-semibold text-foreground">{formatMoney(group.total, group.currency)}</span>{" "}
            across {group.itemCount} {group.itemCount === 1 ? "polish" : "polishes"}
          </p>
          <ul aria-hidden className="space-y-2">
            {group.byBrand.map((entry) => {
              const max = group.byBrand[0]?.total ?? 0;
              const name = entry.isOther ? `Other (${entry.brandCount} brands)` : entry.brand;
              const value = formatMoney(entry.total, group.currency);
              return (
                <li
                  key={`${entry.isOther}-${entry.brand}`}
                  className="group flex items-center gap-3"
                  title={`${name}: ${value} · ${entry.itemCount} ${entry.itemCount === 1 ? "polish" : "polishes"}`}
                >
                  <span className="w-28 shrink-0 truncate text-sm">{name}</span>
                  <span className="relative h-3 flex-1">
                    <span
                      className={`absolute inset-y-0 left-0 rounded-r-[4px] transition-opacity group-hover:opacity-80 ${
                        entry.isOther ? "bg-brand-purple/45" : "bg-brand-purple"
                      }`}
                      style={{ width: `${barPercent(entry.total, max)}%` }}
                    />
                  </span>
                  <span className="w-20 shrink-0 text-right text-sm tabular-nums text-muted-foreground">{value}</span>
                </li>
              );
            })}
          </ul>
          {stats && stats.spend.unpricedCount > 0 && (
            <p className="mt-3 text-xs text-muted-foreground">
              {stats.spend.unpricedCount} {stats.spend.unpricedCount === 1 ? "polish has" : "polishes have"} no
              price and {stats.spend.unpricedCount === 1 ? "isn't" : "aren't"} counted.
            </p>
          )}
          <StatsTable
            caption={`Spend by brand, ${label}`}
            columns={["Brand", "Spend", "Polishes"]}
            rows={group.byBrand.map((entry) => [
              entry.isOther ? `Other (${entry.brandCount} brands)` : entry.brand,
              formatMoney(entry.total, group.currency),
              entry.itemCount,
            ])}
          />
        </>
      )}
    </StatsPanel>
  );
}
