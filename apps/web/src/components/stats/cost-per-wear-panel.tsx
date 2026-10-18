import Link from "next/link";
import type { CollectionStatsResponse, CostPerWearEntry } from "swatchwatch-shared";
import { ColorDot } from "@/components/color-dot";
import { currencyLabel, findCostPerWear, formatMoney, statsDisplayHex } from "@/lib/collection-stats";
import { StatsEmpty, StatsPanel } from "./stats-panel";

function CostList({
  title,
  entries,
  currency,
}: {
  title: string;
  entries: CostPerWearEntry[];
  currency: string | null;
}) {
  return (
    <section aria-label={title} className="min-w-0 flex-1">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      <ol className="space-y-1">
        {entries.map((entry) => {
          const body = (
            <>
              <ColorDot hex={statsDisplayHex(entry)} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{entry.name}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {formatMoney(entry.price, currency)} · {entry.wearCount} {entry.wearCount === 1 ? "wear" : "wears"}
                </span>
              </span>
              <span className="shrink-0 text-sm font-medium tabular-nums">
                {formatMoney(entry.costPerWear, currency)}
                <span className="sr-only"> per wear</span>
                <span aria-hidden className="text-xs font-normal text-muted-foreground">/wear</span>
              </span>
            </>
          );
          return (
            <li key={entry.inventoryItemId}>
              {entry.shadeId ? (
                <Link
                  href={`/polishes/detail?id=${entry.shadeId}`}
                  className="flex items-center gap-2 rounded-md p-1.5 transition-colors hover:bg-muted"
                >
                  {body}
                </Link>
              ) : (
                <div className="flex items-center gap-2 p-1.5">{body}</div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** Cost per wear for owned, priced, worn polishes in one currency: best and worst value. */
export function CostPerWearPanel({
  stats,
  currency,
}: {
  stats: CollectionStatsResponse | null;
  currency: string;
}) {
  const group = stats ? findCostPerWear(stats, currency) : undefined;
  const label = group ? currencyLabel(group.currency) : null;

  return (
    <StatsPanel
      title="Cost per wear"
      description={label ? `Price ÷ manis logged, ${label}` : "Price ÷ manis logged"}
      loading={!stats}
    >
      {stats && (!group || group.wornCount === 0) && (
        <StatsEmpty
          message={
            group && group.pricedUnwornCount > 0
              ? `${group.pricedUnwornCount} priced ${group.pricedUnwornCount === 1 ? "polish is" : "polishes are"} waiting for a first wear. Log a mani to see cost per wear.`
              : "Add a purchase price and log a mani to see cost per wear."
          }
          actionLabel="Log a mani"
          actionHref="/manis"
        />
      )}
      {group && group.wornCount > 0 && (
        <>
          <div className="flex flex-col gap-4 sm:flex-row">
            <CostList title="Best value" entries={group.best} currency={group.currency} />
            {group.worst.length > 0 && (
              <CostList title="Worst value" entries={group.worst} currency={group.currency} />
            )}
          </div>
          {group.pricedUnwornCount > 0 && (
            <p className="mt-3 text-xs text-muted-foreground">
              {group.pricedUnwornCount} priced {group.pricedUnwornCount === 1 ? "polish hasn't" : "polishes haven't"}{" "}
              been worn yet.
            </p>
          )}
        </>
      )}
    </StatsPanel>
  );
}
