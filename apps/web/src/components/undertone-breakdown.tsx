"use client";

import type { Undertone } from "@/lib/color-utils";

interface UndertoneBreakdownProps {
  warm: number;
  cool: number;
  neutral: number;
  total: number;
}

const barColors: Record<Undertone, string> = {
  warm: "bg-amber-400 dark:bg-amber-500",
  cool: "bg-sky-400 dark:bg-sky-500",
  neutral: "bg-stone-400 dark:bg-stone-500",
};

const dotColors: Record<Undertone, string> = {
  warm: "bg-amber-400",
  cool: "bg-sky-400",
  neutral: "bg-stone-400",
};

export function UndertoneBreakdown({ warm, cool, neutral, total }: UndertoneBreakdownProps) {
  if (total === 0) return null;

  const pct = (n: number) => Math.round((n / total) * 100);

  const segments = ([
    { tone: "warm" as const, count: warm },
    { tone: "cool" as const, count: cool },
    { tone: "neutral" as const, count: neutral },
  ] satisfies { tone: Undertone; count: number }[]).filter((s) => s.count > 0);

  return (
    <div className="space-y-3">
      {/* Stacked bar */}
      <div className="flex h-4 rounded-full overflow-hidden bg-muted">
        {segments.map(({ tone, count }) => (
          <div
            key={tone}
            className={`${barColors[tone]} transition-all`}
            style={{ width: `${pct(count)}%` }}
            title={`${tone}: ${count} (${pct(count)}%)`}
          />
        ))}
      </div>

      {/* Legend */}
      <div className="flex justify-between text-sm">
        {(["warm", "cool", "neutral"] as const).map((tone) => {
          const count = tone === "warm" ? warm : tone === "cool" ? cool : neutral;
          return (
            <div key={tone} className="flex items-center gap-1.5">
              <span className={`inline-block h-2.5 w-2.5 rounded-full ${dotColors[tone]}`} />
              <span className="capitalize">{tone}</span>
              <span className="text-muted-foreground">{pct(count)}%</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
