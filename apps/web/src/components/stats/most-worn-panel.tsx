import Link from "next/link";
import type { CollectionStatsResponse } from "swatchwatch-shared";
import { ColorDot } from "@/components/color-dot";
import { Badge } from "@/components/ui/badge";
import { formatWornDate, statsDisplayHex } from "@/lib/collection-stats";
import { POLISH_STATUS_LABELS } from "@/lib/inventory-status";
import { StatsEmpty, StatsPanel } from "./stats-panel";
import { detailHref } from "@/lib/detail-href";

/** Top 10 polishes by wear count, with swatches and last-worn dates. */
export function MostWornPanel({ stats }: { stats: CollectionStatsResponse | null }) {
  const entries = stats?.mostWorn ?? [];
  return (
    <StatsPanel title="Most worn" description="Your top 10 by manis logged" loading={!stats}>
      {stats && entries.length === 0 && (
        <StatsEmpty
          message="Log a mani to start tracking your most-worn polishes."
          actionLabel="Log a mani"
          actionHref="/manis"
        />
      )}
      {entries.length > 0 && (
        <ol className="space-y-1">
          {entries.map((entry, index) => {
            const body = (
              <>
                <span aria-hidden className="w-5 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                  {index + 1}
                </span>
                <ColorDot hex={statsDisplayHex(entry)} size="md" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{entry.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {entry.brand} · last worn {formatWornDate(entry.lastWornAt)}
                  </span>
                </span>
                {entry.status !== "owned" && (
                  <Badge variant="outline" className="shrink-0">
                    {POLISH_STATUS_LABELS[entry.status]}
                  </Badge>
                )}
                <span className="shrink-0 text-sm tabular-nums">
                  {entry.wearCount} {entry.wearCount === 1 ? "wear" : "wears"}
                </span>
              </>
            );
            return (
              <li key={entry.inventoryItemId}>
                {entry.shadeId ? (
                  <Link
                    href={detailHref(entry.shadeId)}
                    className="flex items-center gap-3 rounded-md p-2 transition-colors hover:bg-muted"
                  >
                    {body}
                  </Link>
                ) : (
                  <div className="flex items-center gap-3 p-2">{body}</div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </StatsPanel>
  );
}
