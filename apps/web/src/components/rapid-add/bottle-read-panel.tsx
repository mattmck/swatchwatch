"use client";

import type { CaptureReadSummary } from "swatchwatch-shared";
import { ColorDot } from "@/components/color-dot";
import { Badge } from "@/components/ui/badge";
import { readPanelRows } from "@/lib/bottle-rapid-add";
import { cn } from "@/lib/utils";

export interface BottleReadPanelProps {
  /** What the server has read from this bottle's photos so far (null before the first answer). */
  summary: CaptureReadSummary | null;
  /** A barcode decoded on this device, shown before the server answers. */
  liveBarcode: string | null;
}

/**
 * "What we've read": the barcode, brand, shade name, color and finish gleaned from the photos
 * so far, with the ones the latest photo added highlighted.
 */
export function BottleReadPanel({ summary, liveBarcode }: BottleReadPanelProps) {
  const rows = readPanelRows(summary, liveBarcode);
  return (
    <section aria-label="What we've read" className="rounded-xl border border-border/60 bg-card/60 p-3">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">What we&apos;ve read</h3>
      <dl className="grid gap-1.5" aria-live="polite">
        {rows.map((row) => (
          <div
            key={row.field}
            className={cn(
              "flex items-start gap-3 rounded-md px-2 py-1 transition-colors",
              row.isNew && "bg-emerald-50 dark:bg-emerald-950/30",
            )}
          >
            <dt className="w-24 shrink-0 text-xs text-muted-foreground">{row.label}</dt>
            <dd className="min-w-0 flex-1 text-sm">
              {row.value ? (
                <>
                  <span className="flex items-center gap-2 font-medium">
                    {row.hex && <ColorDot hex={row.hex} size="sm" />}
                    <span className={cn("truncate", row.field === "gtin" && "tabular-nums")}>{row.value}</span>
                    {row.isNew && (
                      <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                        New
                      </Badge>
                    )}
                  </span>
                  {row.detail && (
                    <span className={cn("block text-xs", row.needsCheck ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground")}>
                      {row.detail}
                    </span>
                  )}
                </>
              ) : (
                <span className="text-muted-foreground">Not read yet</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
