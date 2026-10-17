import type { ReactNode } from "react";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * Shared chrome for the dashboard's collection stats panels (#271): a card with the brand
 * accent stripe, a title and description, and either the panel body, a loading skeleton or an
 * empty state. Every chart in a panel is decorative (`aria-hidden`) and paired with a table
 * view (`StatsTable`), so nothing is conveyed by color or shape alone.
 */
export function StatsPanel({
  title,
  description,
  loading,
  className,
  children,
}: {
  title: string;
  description: string;
  /** Render the skeleton instead of `children`. */
  loading?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <Card className={cn("relative overflow-hidden", className)} aria-busy={loading || undefined}>
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-1 bg-gradient-to-b from-brand-purple via-brand-lilac to-brand-pink-soft"
      />
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>{loading ? <StatsSkeleton /> : children}</CardContent>
    </Card>
  );
}

/** Placeholder rows shown while `/api/stats/collection` loads. */
export function StatsSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading" className="space-y-3">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          <div className="h-3 w-20 animate-pulse rounded bg-muted" />
          <div
            className="h-3 animate-pulse rounded bg-muted"
            style={{ width: `${70 - i * 10}%` }}
          />
        </div>
      ))}
      <span className="sr-only">Loading…</span>
    </div>
  );
}

/** Compact empty state for one panel. */
export function StatsEmpty({
  message,
  actionLabel,
  actionHref,
}: {
  message: string;
  actionLabel?: string;
  actionHref?: string;
}) {
  return (
    <div className="flex min-h-[140px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border px-4 py-6 text-center">
      <p className="text-sm text-muted-foreground">{message}</p>
      {actionLabel && actionHref && (
        <Link href={actionHref} className="text-sm font-medium text-primary underline-offset-4 hover:underline">
          {actionLabel}
        </Link>
      )}
    </div>
  );
}

/**
 * Text alternative for a chart: a collapsible, fully labelled table (keyboard and
 * screen-reader reachable).
 */
export function StatsTable({
  caption,
  columns,
  rows,
}: {
  caption: string;
  columns: string[];
  rows: Array<Array<ReactNode>>;
}) {
  return (
    <details className="mt-3 text-sm">
      <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">
        View as table
      </summary>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-left">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="border-b border-border text-muted-foreground">
              {columns.map((column, i) => (
                <th key={column} scope="col" className={cn("py-1 font-medium", i > 0 && "text-right")}>
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((cells, r) => (
              <tr key={r} className="border-b border-border/50 last:border-0">
                {cells.map((cell, c) =>
                  c === 0 ? (
                    <th key={c} scope="row" className="py-1 font-normal">
                      {cell}
                    </th>
                  ) : (
                    <td key={c} className="py-1 text-right tabular-nums">
                      {cell}
                    </td>
                  )
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
