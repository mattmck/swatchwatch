"use client";

import { Suspense, useState, useEffect, useMemo, useCallback, useRef } from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { Polish, PolishStatus } from "swatchwatch-shared";
import { resolveDisplayHex } from "swatchwatch-shared";
import { deletePolish, listAllPolishes, listPolishes, recalcPolishHex, updatePolish } from "@/lib/api";
import { undertone, type Undertone } from "@/lib/color-utils";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ArrowDown, ArrowUp, ArrowUpDown, Loader2, Sparkles, Upload } from "lucide-react";
import { ColorDot } from "@/components/color-dot";
import { LogManiButton } from "@/components/log-mani-button";
import { WishlistShareCard } from "@/components/wishlist-share-card";
import { CollectionQuickActions, type QuickActionSource } from "@/components/collection-quick-actions";
import { StatusChip, UntriedBadge } from "@/components/status-chip";
import { StatusFilter } from "@/components/status-filter";
import { isArchivingChange, isOwnedPolish, quantityChangeUpdate } from "@/lib/inventory-status";
import { showArchivedToast } from "@/components/archived-toast";
import {
  applyInventoryPatch,
  applyOptimistic,
  collectionActionRequest,
  commitOptimistic,
  optimisticPolish,
  rollbackOptimistic,
  statusChangeEvent,
  type CollectionAction,
} from "@/lib/collection-actions";
import {
  buildPolishesListQueryString,
  hasActiveFilters as listHasActiveFilters,
  parsePolishesListState,
  statusPresetFor,
  toApiFilters,
  type PolishesListState,
  type SortDirection,
  type SortKey,
} from "@/lib/polish-list-url";
import { trackEvent } from "@/lib/telemetry";
import { Pagination } from "@/components/pagination";
import { BrandSpinner } from "@/components/brand-spinner";
import { ErrorState } from "@/components/error-state";
import { EmptyState } from "@/components/empty-state";
import { buildFinishOptions, knownFinishNames } from "@/lib/finish-options";
import { FinishBadges } from "@/components/finish-badges";
import { BuyFromBrandLink } from "@/components/buy-from-brand-link";
import { ColorFamilyChips } from "@/components/color-family-chips";
import { parseColorFamilyParam, serializeColorFamilies } from "@/lib/color-family-filter";
import { buildSwatchThumbnailUrl } from "@/lib/image-url";
import { runRecalcHexFlow } from "@/lib/recalc-hex-flow";
import { useAuth, useDevAuth, useUnconfiguredAuth } from "@/hooks/use-auth";
import { useReferenceData } from "@/hooks/use-reference-data";
import { buildMsalConfig } from "@/lib/msal-config";
import { toast } from "sonner";

/** Idle time after the last keystroke before the search box triggers a fetch. */
const SEARCH_DEBOUNCE_MS = 350;
const IS_DEV_BYPASS = process.env.NEXT_PUBLIC_AUTH_DEV_BYPASS === "true";
const HAS_B2C_CONFIG = buildMsalConfig() !== null;

/** The PUT response carries no `buyUrl` (#267), so keep the one already on the row. */
function keepBuyUrl(updated: Polish, previous: Polish): Polish {
  return updated.buyUrl === undefined && previous.buyUrl !== undefined
    ? { ...updated, buyUrl: previous.buyUrl }
    : updated;
}

export default function PolishesPage() {
  return (
    <Suspense fallback={<PolishesPageFallback />}>
      <PolishesPageInner />
    </Suspense>
  );
}

function PolishesPageInner() {
  if (IS_DEV_BYPASS) {
    return <DevPolishesPage />;
  }

  if (!HAS_B2C_CONFIG) {
    return <UnconfiguredPolishesPage />;
  }

  return <B2CPolishesPage />;
}

function PolishesPageFallback() {
  return (
    <div className="flex min-h-[420px] items-center justify-center">
      <BrandSpinner className="h-9 w-9" />
    </div>
  );
}

function DevPolishesPage() {
  const { isAdmin } = useDevAuth();
  return <PolishesPageContentBoundary isAdmin={isAdmin} />;
}

function B2CPolishesPage() {
  const { isAdmin } = useAuth();
  return <PolishesPageContentBoundary isAdmin={isAdmin} />;
}

function UnconfiguredPolishesPage() {
  const { isAdmin } = useUnconfiguredAuth();
  return <PolishesPageContentBoundary isAdmin={isAdmin} />;
}

function PolishesPageContentBoundary({ isAdmin }: { isAdmin: boolean }) {
  return (
    <Suspense fallback={<BrandSpinner label="Loading polishes…" />}>
      <PolishesPageContent isAdmin={isAdmin} />
    </Suspense>
  );
}

function PolishesPageContent({ isAdmin }: { isAdmin: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const searchParamsString = searchParams.toString();
  const didMountRef = useRef(false);
  const skipNextPageResetRef = useRef(false);
  const [polishes, setPolishes] = useState<Polish[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { finishTypes } = useReferenceData();
  const finishOptions = useMemo(() => buildFinishOptions(finishTypes), [finishTypes]);
  const knownFinishes = useMemo(() => knownFinishNames(finishTypes), [finishTypes]);

  // Filters (URL state: see lib/polish-list-url.ts; legacy scope/availability links are mapped
  // to `status` once and the canonical URL is written back).
  const [initialState] = useState(() => parsePolishesListState(searchParams));
  const [search, setSearch] = useState(initialState.search);
  const [statuses, setStatuses] = useState<PolishStatus[]>(initialState.statuses);
  const [untried, setUntried] = useState(initialState.untried);
  const [toneFilter, setToneFilter] = useState<Undertone | "all">(initialState.toneFilter);
  const [finishFilter, setFinishFilter] = useState<string>(initialState.finishFilter);
  // Canonical comma-separated color families (`red,pink`, #103); "" = no family filter.
  const [familyFilter, setFamilyFilter] = useState<string>(initialState.familyFilter);
  const selectedFamilies = useMemo(() => parseColorFamilyParam(familyFilter), [familyFilter]);
  const [sortKey, setSortKey] = useState<SortKey>(initialState.sortKey);
  const [sortDirection, setSortDirection] = useState<SortDirection>(initialState.sortDirection);
  const statusesKey = statuses.join(",");

  // Pagination
  const [page, setPage] = useState(initialState.page);
  const [pageSize, setPageSize] = useState(initialState.pageSize);
  const [recalcPendingById, setRecalcPendingById] = useState<
    Record<string, boolean>
  >({});
  // Rows with a status/tried request in flight (their quick actions are disabled meanwhile).
  const [actionPendingById, setActionPendingById] = useState<Record<string, boolean>>({});
  const [debouncedSearch, setDebouncedSearch] = useState(initialState.search);

  // Keep local state in sync with browser URL changes (back/forward).
  useEffect(() => {
    const next = parsePolishesListState(new URLSearchParams(searchParamsString));

    // The URL only ever carries the debounced search, so compare against that: comparing the
    // live input would revert characters typed between the debounce firing and the URL echo.
    const searchChangedFromUrl = debouncedSearch !== next.search;
    const statusesChangedFromUrl = statusesKey !== next.statuses.join(",");
    const filtersChangedFromUrl =
      statusesChangedFromUrl ||
      untried !== next.untried ||
      toneFilter !== next.toneFilter ||
      finishFilter !== next.finishFilter ||
      familyFilter !== next.familyFilter ||
      sortKey !== next.sortKey ||
      sortDirection !== next.sortDirection;
    const paginationChangedFromUrl = page !== next.page || pageSize !== next.pageSize;

    if (!filtersChangedFromUrl && !paginationChangedFromUrl && !searchChangedFromUrl) {
      return;
    }

    // Avoid resetting page to 1 when state updates are driven by URL navigation.
    skipNextPageResetRef.current = true;

    if (searchChangedFromUrl) {
      setSearch(next.search);
      setDebouncedSearch(next.search);
    }
    if (statusesChangedFromUrl) setStatuses(next.statuses);
    setUntried(next.untried);
    setToneFilter(next.toneFilter);
    setFinishFilter(next.finishFilter);
    setFamilyFilter(next.familyFilter);
    setSortKey(next.sortKey);
    setSortDirection(next.sortDirection);
    setPage(next.page);
    setPageSize(next.pageSize);
  }, [searchParamsString]);

  // Filter/sort state the API request and URL are built from (page/pageSize applied separately).
  const listState = useMemo<PolishesListState>(
    () => ({
      search: debouncedSearch,
      statuses: statusesKey ? (statusesKey.split(",") as PolishStatus[]) : [],
      untried,
      toneFilter,
      finishFilter,
      familyFilter,
      sortKey,
      sortDirection,
      page: 1,
      pageSize: 0,
    }),
    [debouncedSearch, statusesKey, untried, toneFilter, finishFilter, familyFilter, sortKey, sortDirection]
  );

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDebouncedSearch(search);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timeoutId);
  }, [search]);

  useEffect(() => {
    let cancelled = false;

    async function fetchPolishesPage() {
      try {
        setLoading(true);
        setError(null);

        const baseFilters = toApiFilters(listState);

        if (toneFilter !== "all") {
          const allRows = await listAllPolishes(baseFilters);
          const toneRows = allRows.filter((polish) => {
            const hex = resolveDisplayHex(polish);
            return hex ? undertone(hex) === toneFilter : false;
          });
          const nextTotal = toneRows.length;
          const totalPagesForTone = Math.ceil(nextTotal / pageSize);
          const safePage = totalPagesForTone > 0 ? Math.min(page, totalPagesForTone) : 1;
          const pagedRows = toneRows.slice((safePage - 1) * pageSize, safePage * pageSize);

          if (!cancelled) {
            setPolishes(pagedRows);
            setTotal(nextTotal);
            if (safePage !== page) {
              setPage(safePage);
            }
          }
          return;
        }

        const response = await listPolishes({
          ...baseFilters,
          page,
          pageSize,
        });

        if (!cancelled) {
          setPolishes(response.polishes);
          setTotal(response.total);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Failed to load polishes";
        if (!cancelled) {
          setError(message);
        }
      } finally {
        if (!cancelled) {
          setHasLoaded(true);
          setLoading(false);
        }
      }
    }
    void fetchPolishesPage();

    return () => {
      cancelled = true;
    };
  }, [listState, page, pageSize, toneFilter]);

  // Reset page when filters change (but keep initial URL-restored page).
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    if (skipNextPageResetRef.current) {
      skipNextPageResetRef.current = false;
      return;
    }
    setPage(1);
  }, [debouncedSearch, statusesKey, untried, toneFilter, finishFilter, familyFilter, sortKey, sortDirection]);

  const queryString = useMemo(
    () => buildPolishesListQueryString({ ...listState, page, pageSize }),
    [listState, page, pageSize]
  );
  const returnToHref = queryString ? `${pathname}?${queryString}` : pathname;

  // Persist list state in URL to support back/forward restoration.
  useEffect(() => {
    const nextQuery = queryString;
    const currentQuery = searchParamsString;
    if (nextQuery === currentQuery) return;

    router.replace(nextQuery ? `${pathname}?${nextQuery}` : pathname, {
      scroll: false,
    });
  }, [pathname, queryString, router, searchParamsString]);

  const hasActiveFilters = listHasActiveFilters({ search, statuses, untried, toneFilter, finishFilter, familyFilter });

  const handleSort = useCallback((key: SortKey) => {
    if (sortKey === key) {
      setSortDirection((currentDirection) => (currentDirection === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(key);
    setSortDirection("asc");
  }, [sortKey]);

  const renderSortIcon = (column: SortKey) => {
    if (sortKey !== column) {
      return <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground/70" />;
    }
    return sortDirection === "asc"
      ? <ArrowUp className="h-3.5 w-3.5 text-primary" />
      : <ArrowDown className="h-3.5 w-3.5 text-primary" />;
  };
  const getAriaSort = (column: SortKey): "ascending" | "descending" | "none" => {
    if (sortKey !== column) return "none";
    return sortDirection === "asc" ? "ascending" : "descending";
  };

  const totalPages = Math.ceil(total / pageSize);
  const pageItems = polishes;
  const columnCount = 9 + (isAdmin ? 1 : 0);

  useEffect(() => {
    if (totalPages === 0 && page !== 1) {
      setPage(1);
      return;
    }
    if (totalPages > 0 && page > totalPages) {
      setPage(totalPages);
    }
  }, [page, totalPages]);

  /** The archive toast's reason / Undo answers (D5c): replace the row, keeping its buyUrl. */
  const applyArchiveToastUpdate = useCallback((updated: Polish) => {
    setPolishes((prev) => prev.map((p) => (p.id === updated.id ? keepBuyUrl(updated, p) : p)));
  }, []);

  // Optimistic quantity update (stepper). Rollback only touches the row if no newer change
  // replaced it (see lib/collection-actions.ts).
  const handleQuantityChange = useCallback(
    (polishId: string, delta: number) => {
      const original = polishes.find((p) => p.id === polishId);
      if (!original) return;

      const change = quantityChangeUpdate(original, delta);
      const optimistic = applyInventoryPatch(original, change);
      setPolishes((prev) => applyOptimistic(prev, polishId, optimistic));

      updatePolish(polishId, change)
        .then((updated) => {
          setPolishes((prev) => commitOptimistic(prev, polishId, optimistic, keepBuyUrl(updated, original)));
          if (change.status !== original.status) {
            trackEvent("collection.status_changed", statusChangeEvent(original.status, change.status, "stepper"));
          }
          if (isArchivingChange(original, change)) {
            showArchivedToast({ polish: updated, onUpdated: applyArchiveToastUpdate });
          }
        })
        .catch(() => {
          setPolishes((prev) => rollbackOptimistic(prev, polishId, optimistic, original));
          toast.error(`Couldn’t update ${original.brand} ${original.name}`);
        });
    },
    [applyArchiveToastUpdate, polishes]
  );

  // Optimistic status / tried-date quick actions with rollback on error.
  const handleCollectionAction = useCallback(
    (polishId: string, action: CollectionAction, source: QuickActionSource) => {
      const original = polishes.find((p) => p.id === polishId);
      if (!original || actionPendingById[polishId]) return;
      const request = collectionActionRequest(original, action);
      if (!request) return;

      const optimistic = optimisticPolish(original, action);
      setPolishes((prev) => applyOptimistic(prev, polishId, optimistic));
      setActionPendingById((prev) => ({ ...prev, [polishId]: true }));

      const settle = () =>
        setActionPendingById((prev) => {
          const next = { ...prev };
          delete next[polishId];
          return next;
        });

      const send: Promise<Polish> =
        request.method === "delete"
          ? deletePolish(polishId).then(() => optimistic)
          : updatePolish(polishId, request.body);

      send
        .then((updated) => {
          setPolishes((prev) => commitOptimistic(prev, polishId, optimistic, keepBuyUrl(updated, original)));
          if (action.kind === "set-tried") {
            trackEvent("collection.tried_changed", { tried: action.date !== null, via: source });
          } else {
            trackEvent(
              "collection.status_changed",
              statusChangeEvent(original.status, optimistic.status ?? null, source)
            );
            // Archiving an owned polish from the menu records `used_up`; offer the reason / Undo.
            if (action.kind === "set-status" && isArchivingChange(original, action)) {
              showArchivedToast({ polish: updated, onUpdated: applyArchiveToastUpdate });
            }
          }
        })
        .catch((err: unknown) => {
          setPolishes((prev) => rollbackOptimistic(prev, polishId, optimistic, original));
          const reason = err instanceof Error && err.message ? `: ${err.message}` : "";
          toast.error(`Couldn’t update ${original.brand} ${original.name}${reason}`);
        })
        .finally(settle);
    },
    [actionPendingById, applyArchiveToastUpdate, polishes]
  );

  const handleRecalcHex = useCallback(async (polishId: string) => {
    await runRecalcHexFlow({
      polishId,
      recalc: recalcPolishHex,
      knownFinishes,
      setPendingById: setRecalcPendingById,
      setPolishes,
      toast,
    });
  }, [knownFinishes]);

  // Full-page spinner only before the first result: unmounting the page on every refetch
  // would drop the search input (and its focus) mid-typing.
  if (loading && !hasLoaded) {
    return <BrandSpinner label="Loading polishes…" />;
  }

  if (error) {
    return <ErrorState message={error} onRetry={() => window.location.reload()} />;
  }

  return (
    <div className="space-y-4">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="heading-page">All Polishes</h1>
          <p className="text-muted-foreground">
            {total} polishes &middot; {polishes.length} shown
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <Link href="/polishes/import">
              <Upload aria-hidden="true" />
              Import
            </Link>
          </Button>
          <Button asChild>
            <Link href="/polishes/new">+ Add Polish</Link>
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <Input
          placeholder="Search by name, brand, or color..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-xs"
        />

        <StatusFilter
          statuses={statuses}
          untried={untried}
          onStatusesChange={setStatuses}
          onUntriedChange={setUntried}
        />

        <div className="flex flex-wrap items-center gap-2">
          <Select value={toneFilter} onValueChange={(v) => setToneFilter(v as Undertone | "all")}>
            <SelectTrigger className="h-8 w-[140px]">
              <SelectValue placeholder="Tone" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Tones</SelectItem>
              <SelectItem value="warm">Warm</SelectItem>
              <SelectItem value="cool">Cool</SelectItem>
              <SelectItem value="neutral">Neutral</SelectItem>
            </SelectContent>
          </Select>

          <Select value={finishFilter} onValueChange={setFinishFilter}>
            <SelectTrigger className="h-8 w-[160px]">
              <SelectValue placeholder="Finish" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Finishes</SelectItem>
              {finishOptions.map((finish) => (
                <SelectItem key={finish.value} value={finish.value}>
                  {finish.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

        </div>

        {hasActiveFilters && (
          <Button
            variant="ghost"
            size="sm"
            className="text-brand-purple hover:bg-brand-pink-light/30"
            onClick={() => {
              setSearch("");
              setStatuses([]);
              setUntried(false);
              setToneFilter("all");
              setFinishFilter("all");
              setFamilyFilter("");
            }}
          >
            Clear filters
          </Button>
        )}
      </div>

      <ColorFamilyChips
        value={selectedFamilies}
        onChange={(next) => setFamilyFilter(serializeColorFamilies(next))}
      />
      {/* Opt-in public wishlist link (#268); hidden unless the server flag is on. */}
      {statusPresetFor(statuses) === "wishlist" && <WishlistShareCard />}

      {/* Table */}
      <div
        className={`relative overflow-hidden rounded-lg border transition-opacity ${
          loading ? "opacity-60" : ""
        }`}
        aria-busy={loading}
      >
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 w-1 bg-gradient-to-b from-brand-pink-soft via-brand-lilac to-brand-purple"
        />
        <Table>
          <TableHeader className="sticky top-0 z-10">
            <TableRow className="glass border-b border-border/60">
              <TableHead className="w-28" aria-sort={getAriaSort("status")}>
                <button
                  type="button"
                  className="flex items-center gap-1 text-xs font-medium"
                  onClick={() => handleSort("status")}
                  aria-label="Sort by status"
                >
                  <span>Status</span>
                  {renderSortIcon("status")}
                </button>
              </TableHead>
              <TableHead className="w-12">Image</TableHead>
              <TableHead aria-sort={getAriaSort("brand")}>
                <button
                  type="button"
                  className="flex items-center gap-1 text-xs font-medium"
                  onClick={() => handleSort("brand")}
                  aria-label="Sort by brand"
                >
                  <span>Brand</span>
                  {renderSortIcon("brand")}
                </button>
              </TableHead>
              <TableHead aria-sort={getAriaSort("name")}>
                <button
                  type="button"
                  className="flex items-center gap-1 text-xs font-medium"
                  onClick={() => handleSort("name")}
                  aria-label="Sort by name"
                >
                  <span>Name</span>
                  {renderSortIcon("name")}
                </button>
              </TableHead>
              <TableHead className="w-14">Color</TableHead>
              <TableHead className="w-12">Find</TableHead>
              <TableHead aria-sort={getAriaSort("finish")}>
                <button
                  type="button"
                  className="flex items-center gap-1 text-xs font-medium"
                  onClick={() => handleSort("finish")}
                  aria-label="Sort by finish"
                >
                  <span>Finish</span>
                  {renderSortIcon("finish")}
                </button>
              </TableHead>
              <TableHead aria-sort={getAriaSort("collection")}>
                <button
                  type="button"
                  className="flex items-center gap-1 text-xs font-medium"
                  onClick={() => handleSort("collection")}
                  aria-label="Sort by collection"
                >
                  <span>Collection</span>
                  {renderSortIcon("collection")}
                </button>
              </TableHead>
              {isAdmin && (
                <TableHead className="w-28 text-right">Recalc Hex</TableHead>
              )}
              <TableHead className="w-40 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pageItems.length === 0 ? (
              <TableRow>
                <TableCell colSpan={columnCount} className="p-0">
                  <EmptyState
                    title={hasActiveFilters ? "No matches" : "No polishes yet"}
                    description={hasActiveFilters ? "Try adjusting your filters." : "Add your first polish to get started."}
                    actionLabel={hasActiveFilters ? undefined : "+ Add Polish"}
                    actionHref={hasActiveFilters ? undefined : "/polishes/new"}
                  />
                </TableCell>
              </TableRow>
            ) : (
              pageItems.map((polish) => {
                const recalcPending = recalcPendingById[polish.id] === true;
                return (
                  <TableRow
                    key={polish.id}
                    className="transition-colors hover:bg-brand-pink-light/20"
                  >
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1">
                        <StatusChip status={polish.status} />
                        {polish.isUntried && <UntriedBadge />}
                      </div>
                    </TableCell>
                    <TableCell>
                      {polish.swatchImageUrl ? (
                        <a
                          href={polish.swatchImageUrl}
                          target="_blank"
                          rel="noreferrer"
                          aria-label={`Open ${polish.brand} ${polish.name} swatch image in new tab`}
                          className="inline-block"
                        >
                          <Image
                            src={buildSwatchThumbnailUrl(polish.swatchImageUrl)}
                            alt={`${polish.brand} ${polish.name} swatch`}
                            width={40}
                            height={40}
                            unoptimized
                            sizes="40px"
                            className="h-10 w-10 rounded-md border object-cover transition-opacity hover:opacity-85"
                          />
                        </a>
                      ) : (
                        <div className="h-10 w-10 rounded-md border bg-muted/40" />
                      )}
                    </TableCell>
                    <TableCell className="font-medium">{polish.brand}</TableCell>
                    <TableCell>
                      <Link
                        href={`/polishes/detail?id=${polish.id}&returnTo=${encodeURIComponent(returnToHref)}`}
                        className="text-primary hover:underline"
                      >
                        {polish.name}
                      </Link>
                      <BuyFromBrandLink
                        url={polish.buyUrl}
                        brand={polish.brand}
                        name={polish.name}
                        className="mt-0.5 flex w-fit"
                      />
                    </TableCell>
                    <TableCell>
                      <ColorDot
                        hex={resolveDisplayHex(polish)}
                        size="md"
                        className="ring-2 ring-white/80 shadow-[0_0_0_1px_rgba(66,16,126,0.18),0_8px_20px_rgba(66,16,126,0.16)]"
                      />
                    </TableCell>
                    <TableCell className="text-center">
                      {resolveDisplayHex(polish) && (
                        <Link
                          href={`/polishes/search?color=${resolveDisplayHex(polish)!.replace("#", "")}`}
                          className="text-muted-foreground hover:text-primary"
                          aria-label={`Find colors similar to ${polish.name}`}
                        >
                          <span aria-hidden="true">🔍</span>
                        </Link>
                      )}
                    </TableCell>
                    <TableCell>
                      <FinishBadges polish={polish} finishTypes={finishTypes} max={3} />
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {polish.collection ?? "\u2014"}
                    </TableCell>
                    {isAdmin && (
                      <TableCell className="text-right">
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          className="min-w-[102px] justify-center"
                          disabled={recalcPending}
                          onClick={() => handleRecalcHex(polish.id)}
                        >
                          {recalcPending ? (
                            <Loader2 className="size-3 animate-spin" />
                          ) : (
                            <Sparkles className="size-3" />
                          )}
                          {recalcPending ? "Submitting..." : "Recalc"}
                        </Button>
                      </TableCell>
                    )}
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        {isOwnedPolish(polish) && <LogManiButton polish={polish} variant="icon" />}
                        <CollectionQuickActions
                          polish={polish}
                          pending={actionPendingById[polish.id] === true}
                          onAction={(action, source) => handleCollectionAction(polish.id, action, source)}
                          onQuantityChange={(delta) => handleQuantityChange(polish.id, delta)}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      <Pagination
        currentPage={page}
        totalPages={totalPages}
        totalItems={total}
        pageSize={pageSize}
        onPageChange={setPage}
        onPageSizeChange={(newSize) => {
          setPageSize(newSize);
          setPage(1); // Reset to first page when page size changes
        }}
      />
    </div>
  );
}
