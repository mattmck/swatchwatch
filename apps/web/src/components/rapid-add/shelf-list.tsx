"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Heart, History, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ColorDot } from "@/components/color-dot";
import { manualAddHref } from "@/lib/capture-verdict";
import { detailHref } from "@/lib/detail-href";
import {
  formatShelfAge,
  SHELF_VERDICT_LABELS,
  shelfCounts,
  shelfQuickActions,
  shelfStatus,
  type ShelfEntry,
  type ShelfQuickAction,
  type ShelfVerdict,
} from "@/lib/rapid-add-shelf";
import { cn } from "@/lib/utils";

export interface ShelfListProps {
  entries: readonly ShelfEntry[];
  /** Entry the latest scan matched an earlier one (flagged "Scanned already"). */
  repeatKey: string | null;
  /** Entry whose action is in flight. */
  pendingKey: string | null;
  /** Entry the verdict card shows right now (its actions live on the card). */
  currentKey: string | null;
  onAction: (entry: ShelfEntry, action: Exclude<ShelfQuickAction, "manual">) => void;
  onManualAdd: (entry: ShelfEntry) => void;
  onClear: () => void;
}

const CHIP_CLASSES: Record<ShelfVerdict, string> = {
  owned: "bg-amber-100 text-amber-900 dark:bg-amber-950/50 dark:text-amber-100",
  wishlist: "bg-rose-100 text-rose-900 dark:bg-rose-950/50 dark:text-rose-100",
  near_dupe: "bg-orange-100 text-orange-900 dark:bg-orange-950/50 dark:text-orange-100",
  new: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-100",
  not_found: "bg-muted text-muted-foreground",
};

const ACTED_COPY = {
  added: "Added",
  wishlisted: "On wishlist",
  bought_another: "Bottle added",
} as const;

/** Re-render once a minute so "2 min ago" stays true. */
function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

function entryName(entry: ShelfEntry): string {
  if (entry.display) return entry.display;
  const learned = [entry.brand, entry.shadeName].filter(Boolean).join(" — ");
  if (learned) return learned;
  return entry.gtin ? `Barcode ${entry.gtin}` : "Unnamed scan";
}

function CountPill({ label, value, verdict }: { label: string; value: number; verdict: ShelfVerdict }) {
  return (
    <li className={cn("rounded-full px-2.5 py-1 text-xs font-medium tabular-nums", CHIP_CLASSES[verdict])}>
      {value} {label}
    </li>
  );
}

/**
 * Shelf mode: every scan of this session, newest first, with the verdict it got and the quick
 * actions it still offers, so a shelf of bottles can be checked in one go and acted on after.
 */
export function ShelfList(props: ShelfListProps) {
  const { entries, repeatKey, pendingKey, currentKey } = props;
  const now = useNow();
  if (entries.length === 0) return null;
  const counts = shelfCounts(entries);

  return (
    <section aria-labelledby="rapid-add-shelf-title" className="space-y-3 rounded-xl border border-border/60 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="rapid-add-shelf-title" className="flex items-center gap-2 text-base font-semibold">
          <History className="size-4 text-muted-foreground" aria-hidden />
          This shelf <span className="text-sm font-normal text-muted-foreground">({counts.total})</span>
        </h2>
        <Button type="button" variant="ghost" size="sm" className="pointer-coarse:h-11" onClick={props.onClear}>
          <Trash2 aria-hidden /> Clear shelf
        </Button>
      </div>

      <ul aria-label="Shelf counts" className="flex flex-wrap gap-1.5">
        <CountPill label="own" value={counts.owned} verdict="owned" />
        <CountPill label="wishlist" value={counts.wishlist} verdict="wishlist" />
        <CountPill label="new" value={counts.new} verdict="new" />
        {counts.nearDupe > 0 && <CountPill label="near-dupe" value={counts.nearDupe} verdict="near_dupe" />}
        <CountPill label="not found" value={counts.notFound} verdict="not_found" />
      </ul>

      <ul className="divide-y divide-border/60">
        {entries.map((entry) => {
          const status = shelfStatus(entry);
          const pending = pendingKey === entry.key;
          const isCurrent = currentKey === entry.key;
          const actions = isCurrent ? [] : shelfQuickActions(entry);
          const name = entryName(entry);
          return (
            <li
              key={entry.key}
              className={cn("flex flex-col gap-2 py-3 sm:flex-row sm:items-center", isCurrent && "opacity-80")}
            >
              <div className="flex min-w-0 flex-1 items-start gap-3">
                <span className="mt-0.5 shrink-0">
                  {entry.hex ? (
                    <ColorDot hex={entry.hex} size="md" />
                  ) : (
                    <span
                      aria-hidden
                      className="inline-block size-6 rounded-full border border-dashed border-border bg-muted"
                    />
                  )}
                </span>
                <div className="min-w-0 flex-1 space-y-1">
                  {entry.shadeId ? (
                    <Link href={detailHref(entry.shadeId)} className="block truncate text-sm font-medium hover:underline">
                      {name}
                    </Link>
                  ) : (
                    <p className="truncate text-sm font-medium">{name}</p>
                  )}
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <span className={cn("rounded-full px-2 py-0.5 font-medium", CHIP_CLASSES[entry.verdict])}>
                      {SHELF_VERDICT_LABELS[entry.verdict]}
                    </span>
                    {entry.acted && (
                      <span className={cn("rounded-full px-2 py-0.5 font-medium", CHIP_CLASSES[status])}>
                        {ACTED_COPY[entry.acted]}
                        {typeof entry.quantity === "number" && entry.acted !== "wishlisted" ? ` · ${entry.quantity}` : ""}
                      </span>
                    )}
                    <time dateTime={new Date(entry.lastScannedAt).toISOString()}>
                      {formatShelfAge(entry.lastScannedAt, now)}
                    </time>
                    {isCurrent && <span>· showing above</span>}
                  </div>
                  {entry.verdict === "near_dupe" && entry.dupe && (
                    <p className="text-xs text-muted-foreground">
                      {entry.dupe.grade === "high" ? "Close dupe of" : "Like"} your {entry.dupe.name}
                    </p>
                  )}
                  {repeatKey === entry.key && entry.scanCount > 1 && (
                    <p role="status" className="text-xs font-medium text-amber-700 dark:text-amber-400">
                      Scanned already, {formatShelfAge(entry.firstScannedAt, now)}
                    </p>
                  )}
                </div>
              </div>
              {actions.length > 0 && (
                <div className="flex flex-wrap gap-2 pl-9 sm:pl-0">
                  {actions.map((action) => {
                    if (action === "manual") {
                      return (
                        <Button
                          key={action}
                          asChild
                          variant="outline"
                          size="sm"
                          className="pointer-coarse:h-11"
                          onClick={() => props.onManualAdd(entry)}
                        >
                          <Link href={manualAddHref({ gtin: entry.gtin, format: entry.format, brand: entry.brand, shadeName: entry.shadeName })}>
                            Add manually
                          </Link>
                        </Button>
                      );
                    }
                    const label =
                      action === "wishlist"
                        ? "Wishlist"
                        : action === "bought_another"
                          ? "I bought another"
                          : status === "wishlist"
                            ? "I bought it"
                            : "Add";
                    return (
                      <Button
                        key={action}
                        type="button"
                        variant="outline"
                        size="sm"
                        className="pointer-coarse:h-11"
                        disabled={pending}
                        aria-label={`${label}: ${name}`}
                        onClick={() => props.onAction(entry, action)}
                      >
                        {action === "wishlist" ? <Heart aria-hidden /> : <Plus aria-hidden />}
                        {pending ? "Saving…" : label}
                      </Button>
                    );
                  })}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
