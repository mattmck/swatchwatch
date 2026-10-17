import type { CollectionStatsResponse } from "swatchwatch-shared";
import { ringArc, sharePercent } from "@/lib/collection-stats";
import { StatsEmpty, StatsPanel } from "./stats-panel";

const RING_RADIUS = 42;
const RING_STROKE = 12;

/**
 * "Worn vs waiting" ring (owned polishes worn at least once vs never) plus the untried share
 * (owned polishes never marked tried). The ring is a single-value meter: the filled arc is
 * "worn", the track is "waiting", and both are named with counts beside it.
 */
export function WornVsWaitingPanel({ stats }: { stats: CollectionStatsResponse | null }) {
  const owned = stats?.untried.owned ?? 0;
  const worn = stats?.wornVsWaiting.worn ?? 0;
  const waiting = stats?.wornVsWaiting.waiting ?? 0;
  const wornShare = sharePercent(worn, worn + waiting);
  const arc = ringArc(worn, worn + waiting, RING_RADIUS);
  const size = (RING_RADIUS + RING_STROKE) * 2;

  return (
    <StatsPanel
      title="Worn vs waiting"
      description="Owned polishes you've worn at least once"
      loading={!stats}
    >
      {stats && owned === 0 && (
        <StatsEmpty
          message="Add polishes you own to see how much of your collection gets worn."
          actionLabel="+ Add Polish"
          actionHref="/polishes/new"
        />
      )}
      {stats && owned > 0 && (
        <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-center">
          <div className="relative shrink-0" style={{ width: size, height: size }}>
            <svg
              width={size}
              height={size}
              viewBox={`0 0 ${size} ${size}`}
              role="img"
              aria-label={`${worn} of ${worn + waiting} owned polishes worn (${wornShare ?? 0}%), ${waiting} waiting`}
            >
              <circle
                cx={size / 2}
                cy={size / 2}
                r={RING_RADIUS}
                fill="none"
                strokeWidth={RING_STROKE}
                className="stroke-brand-purple/20 dark:stroke-brand-purple/35"
              />
              {worn > 0 && (
                <circle
                  cx={size / 2}
                  cy={size / 2}
                  r={RING_RADIUS}
                  fill="none"
                  strokeWidth={RING_STROKE}
                  strokeLinecap={worn === worn + waiting ? "butt" : "round"}
                  strokeDasharray={`${arc.filled} ${arc.gap}`}
                  transform={`rotate(-90 ${size / 2} ${size / 2})`}
                  className="stroke-brand-purple"
                />
              )}
            </svg>
            <div aria-hidden className="absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-2xl font-semibold tabular-nums">{wornShare ?? 0}%</span>
              <span className="text-xs text-muted-foreground">worn</span>
            </div>
          </div>
          <div className="w-full space-y-4">
            <dl className="space-y-2 text-sm">
              <div className="flex items-center gap-2">
                <span aria-hidden className="size-3 rounded-full bg-brand-purple" />
                <dt>Worn</dt>
                <dd className="ml-auto tabular-nums font-medium">{worn}</dd>
              </div>
              <div className="flex items-center gap-2">
                <span aria-hidden className="size-3 rounded-full bg-brand-purple/20 dark:bg-brand-purple/35" />
                <dt>Waiting (never worn)</dt>
                <dd className="ml-auto tabular-nums font-medium">{waiting}</dd>
              </div>
            </dl>
            <div className="rounded-lg bg-muted/60 p-3">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Untried</p>
              <p className="text-2xl font-semibold tabular-nums">{stats.untried.percent ?? 0}%</p>
              <p className="text-xs text-muted-foreground">
                {stats.untried.untried} of {owned} owned {owned === 1 ? "polish" : "polishes"} never tried
              </p>
            </div>
          </div>
        </div>
      )}
    </StatsPanel>
  );
}
