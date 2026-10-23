"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { CalendarHeart, Droplets, Pencil, Trash2, X } from "lucide-react";
import type { Manicure, Polish } from "swatchwatch-shared";
import { toast } from "sonner";
import { deleteManicure, listAllPolishes, listManicures } from "@/lib/api";
import {
  CALENDAR_STRIP_WEEKS,
  MANICURE_ROLE_LABELS,
  buildCalendarStrip,
  calendarStripRange,
  formatWornOn,
  manicurePolishHex,
  toLocalIsoDate,
  type CalendarDay,
} from "@/lib/mani-log";
import { BrandSpinner } from "@/components/brand-spinner";
import { ColorDot } from "@/components/color-dot";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { trackOnboardingStepClicked } from "@/lib/metrics-events";
import { CATALOG_SEARCH_HREF } from "@/lib/onboarding";
import { ManiCalendarStrip } from "@/components/mani-calendar-strip";
import { ManiLogForm } from "@/components/mani-log-form";
import { PrivateImage } from "@/components/private-image";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const HISTORY_PAGE_SIZE = 20;

type FormState =
  | { mode: "closed" }
  | { mode: "create"; date?: string; shadeIds?: string[] }
  | { mode: "edit"; manicure: Manicure };

export default function ManisPage() {
  return (
    <Suspense fallback={<BrandSpinner label="Loading your mani log…" />}>
      <ManisPageContent />
    </Suspense>
  );
}

/**
 * Mani log (issue #269): a calendar strip of recent weeks, the full history (newest first,
 * paged) and the "Log a mani" dialog. `?log=<shadeId>` opens the dialog with that polish picked
 * once the collection has loaded.
 */
function ManisPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // `?log=<shadeId>` (from the polish detail page) opens the form with that polish picked.
  const [initialLogShadeId] = useState(() => searchParams.get("log"));
  // `?shade=<shadeId>` (from the polish detail "Worn N times" panel) limits the log to manis with that polish.
  const shadeFilter = searchParams.get("shade");
  const [todayIso] = useState(() => toLocalIsoDate(new Date()));
  const stripRange = useMemo(() => calendarStripRange(todayIso, CALENDAR_STRIP_WEEKS), [todayIso]);

  const [stripManicures, setStripManicures] = useState<Manicure[]>([]);
  const [history, setHistory] = useState<Manicure[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyPage, setHistoryPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collection, setCollection] = useState<Polish[]>([]);
  const [collectionLoading, setCollectionLoading] = useState(true);
  const [form, setForm] = useState<FormState>({ mode: "closed" });
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  /** Fetch the calendar window and the first history page, then apply them (callbacks only). */
  const reload = useCallback(
    () =>
      Promise.all([
        listManicures({ from: stripRange.from, to: stripRange.to, pageSize: 200, shadeId: shadeFilter ?? undefined }),
        listManicures({ page: 1, pageSize: HISTORY_PAGE_SIZE, shadeId: shadeFilter ?? undefined }),
      ])
        .then(([strip, firstPage]) => {
          setError(null);
          setStripManicures(strip.manicures);
          setHistory(firstPage.manicures);
          setHistoryTotal(firstPage.total);
          setHistoryPage(1);
        })
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : "Failed to load your mani log");
        })
        .finally(() => setLoading(false)),
    [stripRange, shadeFilter]
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    let cancelled = false;
    listAllPolishes({ status: ["owned", "destash"] })
      .then((rows) => {
        if (cancelled) return;
        setCollection(rows);
        if (initialLogShadeId) {
          setForm({ mode: "create", shadeIds: [initialLogShadeId] });
          router.replace("/manis");
        }
      })
      .catch(() => {
        if (!cancelled) toast.error("Couldn't load your collection for the polish picker");
      })
      .finally(() => {
        if (!cancelled) setCollectionLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [initialLogShadeId, router]);

  async function loadMore() {
    setLoadingMore(true);
    try {
      const next = await listManicures({ page: historyPage + 1, pageSize: HISTORY_PAGE_SIZE, shadeId: shadeFilter ?? undefined });
      setHistory((current) => [...current, ...next.manicures.filter((m) => !current.some((c) => c.id === m.id))]);
      setHistoryTotal(next.total);
      setHistoryPage(next.page);
    } catch (err: unknown) {
      toast.error("Couldn't load more manis", { description: err instanceof Error ? err.message : undefined });
    } finally {
      setLoadingMore(false);
    }
  }

  async function handleDelete(manicure: Manicure) {
    if (!confirm(`Delete the mani from ${formatWornOn(manicure.wornOn, todayIso)}? Wear counts will be updated.`)) {
      return;
    }
    setDeletingId(manicure.id);
    try {
      await deleteManicure(manicure.id);
      toast.success("Mani deleted");
      await reload();
    } catch (err: unknown) {
      toast.error("Delete failed", { description: err instanceof Error ? err.message : undefined });
    } finally {
      setDeletingId(null);
    }
  }

  function handleSelectDay(day: CalendarDay) {
    if (day.manicures.length === 0) {
      setForm({ mode: "create", date: day.date });
      return;
    }
    setSelectedDate((current) => (current === day.date ? null : day.date));
  }

  const weeks = useMemo(() => buildCalendarStrip(stripManicures, todayIso), [stripManicures, todayIso]);
  const visibleHistory = selectedDate
    ? stripManicures.filter((manicure) => manicure.wornOn === selectedDate)
    : history;
  const stripCount = stripManicures.length;
  const filterLabel = useMemo(() => {
    if (!shadeFilter) return null;
    const found = [...history, ...stripManicures].flatMap((m) => m.polishes).find((p) => p.shadeId === shadeFilter);
    return found ? `${found.brand} ${found.name}` : "one polish";
  }, [shadeFilter, history, stripManicures]);

  if (loading) return <BrandSpinner label="Loading your mani log…" />;
  if (error) return <ErrorState message={error} onRetry={() => void reload()} />;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="heading-page">Mani Log</h1>
          <p className="text-muted-foreground">
            What you wore and when. Logging a mani marks its polishes as tried and updates how often and how
            recently you wore them.
          </p>
        </div>
        <Button onClick={() => setForm({ mode: "create" })} className="bg-gradient-brand text-white">
          <CalendarHeart className="size-4" />
          Log a mani
        </Button>
      </div>

      {shadeFilter && (
        <div>
          <Badge variant="secondary" className="gap-2 py-1">
            Only manis with {filterLabel}
            <Link href="/manis" aria-label="Clear polish filter" className="hover:text-foreground">
              <X className="size-3.5" />
            </Link>
          </Badge>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Last {CALENDAR_STRIP_WEEKS} weeks</CardTitle>
          <CardDescription>
            {stripCount === 0
              ? "No manis logged in this window yet. Tap a day to log one."
              : `${stripCount} mani${stripCount === 1 ? "" : "s"} logged. Tap a day to see it, or an empty day to log one.`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ManiCalendarStrip weeks={weeks} selectedDate={selectedDate} onSelectDay={handleSelectDay} />
        </CardContent>
      </Card>

      <section className="space-y-3" aria-labelledby="mani-history-heading">
        <div className="flex items-center justify-between gap-2">
          <h2 id="mani-history-heading" className="text-lg font-semibold">
            {selectedDate ? formatWornOn(selectedDate, todayIso) : "History"}
          </h2>
          {selectedDate && (
            <Button variant="ghost" size="sm" onClick={() => setSelectedDate(null)}>
              Show all
            </Button>
          )}
        </div>

        {visibleHistory.length === 0 ? (
          !collectionLoading && collection.length === 0 ? (
            <EmptyState
              icon={Droplets}
              title="Your log starts with polishes you own"
              description="Add a few to your collection, then log what you wear to see wear counts and what's still untried."
              actionLabel="Find your polishes"
              actionHref={CATALOG_SEARCH_HREF}
              onAction={() => trackOnboardingStepClicked({ step: "search", surface: "manis_empty", ownedCount: 0 })}
            />
          ) : (
            <EmptyState
              icon={CalendarHeart}
              title="No manis yet"
              description="Log what you're wearing to start tracking wear counts and untried polishes."
              actionLabel="Log a mani"
              onAction={() => setForm({ mode: "create" })}
            />
          )
        ) : (
          <ul className="space-y-3">
            {visibleHistory.map((manicure) => (
              <li key={manicure.id}>
                <ManicureCard
                  manicure={manicure}
                  todayIso={todayIso}
                  deleting={deletingId === manicure.id}
                  onEdit={() => setForm({ mode: "edit", manicure })}
                  onDelete={() => void handleDelete(manicure)}
                />
              </li>
            ))}
          </ul>
        )}

        {!selectedDate && history.length < historyTotal && (
          <div className="flex justify-center">
            <Button variant="outline" onClick={() => void loadMore()} disabled={loadingMore}>
              {loadingMore ? "Loading…" : `Show more (${historyTotal - history.length} older)`}
            </Button>
          </div>
        )}
      </section>

      <ManiLogForm
        open={form.mode !== "closed"}
        onOpenChange={(open) => {
          if (!open) setForm({ mode: "closed" });
        }}
        todayIso={todayIso}
        collection={collection}
        collectionLoading={collectionLoading}
        manicure={form.mode === "edit" ? form.manicure : null}
        initialDate={form.mode === "create" ? form.date : undefined}
        initialShadeIds={form.mode === "create" ? form.shadeIds : undefined}
        onSaved={() => void reload()}
      />
    </div>
  );
}

function ManicureCard({
  manicure,
  todayIso,
  deleting,
  onEdit,
  onDelete,
}: {
  manicure: Manicure;
  todayIso: string;
  deleting: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <Card className="relative overflow-hidden">
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-1 bg-gradient-to-b from-brand-pink-soft via-brand-lilac to-brand-purple"
      />
      <CardContent className="flex gap-4 py-4">
        {manicure.photoUrl && (
          <PrivateImage
            src={manicure.photoUrl}
            alt={`Mani from ${manicure.wornOn}`}
            className="size-20 shrink-0 rounded-lg border object-cover"
          />
        )}
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="font-semibold">{formatWornOn(manicure.wornOn, todayIso)}</p>
              <p className="text-xs text-muted-foreground">{manicure.wornOn}</p>
            </div>
            <div className="flex gap-1">
              <Button size="icon-sm" variant="ghost" onClick={onEdit} aria-label="Edit mani">
                <Pencil className="size-4" />
              </Button>
              <Button size="icon-sm" variant="ghost" onClick={onDelete} disabled={deleting} aria-label="Delete mani">
                <Trash2 className="size-4" />
              </Button>
            </div>
          </div>
          <ul className="flex flex-wrap gap-1.5">
            {manicure.polishes.map((polish) => (
              <li key={`${polish.shadeId}-${polish.role}`}>
                <Badge variant="outline" className="gap-1.5 py-1">
                  <ColorDot hex={manicurePolishHex(polish)} size="sm" />
                  <Link
                    href={`/polishes/detail?id=${polish.shadeId}&returnTo=${encodeURIComponent("/manis")}`}
                    className="max-w-[14rem] truncate hover:underline"
                  >
                    {polish.brand} {polish.name}
                  </Link>
                  <span className="text-muted-foreground">· {MANICURE_ROLE_LABELS[polish.role]}</span>
                </Badge>
              </li>
            ))}
          </ul>
          {manicure.notes && <p className="whitespace-pre-line text-sm text-muted-foreground">{manicure.notes}</p>}
        </div>
      </CardContent>
    </Card>
  );
}
