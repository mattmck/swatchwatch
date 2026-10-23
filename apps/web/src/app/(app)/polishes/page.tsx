"use client";

import { Suspense, useState, useEffect, useMemo, useCallback, useRef } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { Polish, PolishStatus, PolishUpdateRequest } from "swatchwatch-shared";
import { resolveDisplayHex } from "swatchwatch-shared";
import { deletePolish, getPolishDupes, listAllPolishes, listPolishes, recalcPolishHex, updatePolish } from "@/lib/api";
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
import { WishlistValue } from "@/components/wishlist-value";
import { CollectionQuickActions, type QuickActionSource } from "@/components/collection-quick-actions";
import { StatusChip, UntriedBadge } from "@/components/status-chip";
import { StatusFilter } from "@/components/status-filter";
import { CollectionExportMenu } from "@/components/collection-export-menu";
import { PickForMeButton } from "@/components/pick-for-me";
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
  clampPageAfterLoad,
  hasActiveFilters as listHasActiveFilters,
  parsePolishesListState,
  statusPresetFor,
  toApiFilters,
  type PolishesListState,
  type SortDirection,
  type SortKey,
} from "@/lib/polish-list-url";
import { trackEvent } from "@/lib/telemetry";
import { currentCacheContext, ownedListCacheQuery, readOwnedList, writeOwnedList } from "@/lib/api-cache";
import { isApiUnreachable, savedCopyAgeBucket } from "@/lib/offline";
import { trackCollectionOfflineShown } from "@/lib/metrics-events";
import { useOnlineRetry } from "@/hooks/use-online-retry";
import { SavedCopyBanner } from "@/components/saved-copy-banner";
import { DUPE_GRADE_META, dupeHintLabel, dupeHintTitle, dupeHref } from "@/lib/dupes";
import { useDupeHints } from "@/hooks/use-dupe-hints";
import { useAddGuard } from "@/hooks/use-add-guard";
import { AddGuardDialog } from "@/components/add-guard-dialog";
import { shadeGuardKey, wishlistInsteadUpdate, type AddGuardIntent } from "@/lib/add-guard";
import { Pagination } from "@/components/pagination";
import { BrandSpinner } from "@/components/brand-spinner";
import { ErrorState } from "@/components/error-state";
import { PolishesEmptyState } from "@/components/polishes-empty-state";
import { polishesEmptyStateKind, shouldFocusSearch } from "@/lib/onboarding";
import { buildFinishOptions, knownFinishNames } from "@/lib/finish-options";
import { FinishBadges } from "@/components/finish-badges";
import { BuyFromBrandLink } from "@/components/buy-from-brand-link";
import { ColorFamilyChips } from "@/components/color-family-chips";
import { ProductCategoryChips, ProductCategoryPill, TopperSwatch, showsTopperSwatch } from "@/components/product-category";
import { parseProductCategoryParam } from "@/lib/product-category-filter";
import { parseColorFamilyParam, serializeColorFamilies } from "@/lib/color-family-filter";
import { SwatchThumbnail } from "@/components/swatch-thumbnail";
import { runRecalcHexFlow } from "@/lib/recalc-hex-flow";
import { useAuth, useDevAuth, useUnconfiguredAuth } from "@/hooks/use-auth";
import { useReferenceData } from "@/hooks/use-reference-data";
import { buildMsalConfig } from "@/lib/msal-config";
import { toast } from "sonner";
import { detailHref } from "@/lib/detail-href";

/** Idle time after the last keystroke before the search box triggers a fetch. */
const SEARCH_DEBOUNCE_MS = 350;
/** Sort choices for the mobile card list (the table's column headers are not shown there). */
const MOBILE_SORT_OPTIONS: ReadonlyArray<{ key: SortKey; label: string }> = [
  { key: "brand", label: "Brand" },
  { key: "name", label: "Name" },
  { key: "status", label: "Status" },
  { key: "finish", label: "Finish" },
  { key: "collection", label: "Collection" },
];
const IS_DEV_BYPASS = process.env.NEXT_PUBLIC_AUTH_DEV_BYPASS === "true";
const HAS_B2C_CONFIG = buildMsalConfig() !== null;

/** The PUT response carries no `buyUrl` or brand price (#267), so keep the ones already on the row. */
function keepBuyUrl(updated: Polish, previous: Polish): Polish {
  return updated.buyUrl === undefined && previous.buyUrl !== undefined
    ? {
        ...updated,
        buyUrl: previous.buyUrl,
        buyPrice: previous.buyPrice,
        buyCurrency: previous.buyCurrency,
        buyPriceSeenAt: previous.buyPriceSeenAt,
      }
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
  const skipNextPageResetRef = useRef(false);
  const [polishes, setPolishes] = useState<Polish[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Offline: when the API is unreachable and a saved copy of this view exists, `savedAt` is when
  // that copy was loaded. It is shown read-only under a banner (writes and export are disabled).
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const offline = savedAt !== null;
  const { tick: retryTick, retry: retryNow } = useOnlineRetry();
  const hasLoadedRef = useRef(false);
  const { finishTypes } = useReferenceData();
  const finishOptions = useMemo(() => buildFinishOptions(finishTypes), [finishTypes]);
  const knownFinishes = useMemo(() => knownFinishNames(finishTypes), [finishTypes]);

  // Filters (URL state: see lib/polish-list-url.ts; legacy scope/availability links are mapped
  // to `status` once and the canonical URL is written back).
  const [initialState] = useState(() => parsePolishesListState(searchParams));
  // `?focus=search` (getting-started checklist, empty states) opens with the search box focused.
  const [focusSearchOnLoad] = useState(() => shouldFocusSearch(searchParams));
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState(initialState.search);
  const [statuses, setStatuses] = useState<PolishStatus[]>(initialState.statuses);
  const [untried, setUntried] = useState(initialState.untried);
  const [toneFilter, setToneFilter] = useState<Undertone | "all">(initialState.toneFilter);
  const [finishFilter, setFinishFilter] = useState<string>(initialState.finishFilter);
  // Canonical comma-separated color families (`red,pink`, #103); "" = no family filter.
  const [familyFilter, setFamilyFilter] = useState<string>(initialState.familyFilter);
  const selectedFamilies = useMemo(() => parseColorFamilyParam(familyFilter), [familyFilter]);
  // Canonical comma-separated product categories (`color,topper`, #349); "" = every category.
  const [categoryFilter, setCategoryFilter] = useState<string>(initialState.categoryFilter);
  const selectedCategories = useMemo(() => parseProductCategoryParam(categoryFilter), [categoryFilter]);
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
      categoryFilter !== next.categoryFilter ||
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
    setCategoryFilter(next.categoryFilter);
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
      categoryFilter,
      sortKey,
      sortDirection,
      page: 1,
      pageSize: 0,
    }),
    [debouncedSearch, statusesKey, untried, toneFilter, finishFilter, familyFilter, categoryFilter, sortKey, sortDirection]
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
      // Saved copy of the first owned page (stale-while-revalidate): shown at once on a cold
      // view while the request runs, and the fallback when the API cannot be reached.
      const cacheQuery = ownedListCacheQuery({ ...listState, page, pageSize });
      const readSaved = () => {
        const ctx = cacheQuery ? currentCacheContext() : null;
        return ctx && cacheQuery ? readOwnedList(ctx, cacheQuery) : null;
      };
      try {
        setLoading(true);
        setError(null);

        const warm = hasLoadedRef.current ? null : readSaved();
        if (warm) {
          setPolishes(warm.data.polishes);
          setTotal(warm.data.total);
          setHasLoaded(true);
        }

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
          setSavedAt(null);
          const ctx = cacheQuery ? currentCacheContext() : null;
          if (ctx && cacheQuery) writeOwnedList(ctx, cacheQuery, response);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Failed to load polishes";
        if (!cancelled) {
          const saved = isApiUnreachable(err) ? readSaved() : null;
          if (saved) {
            setPolishes(saved.data.polishes);
            setTotal(saved.data.total);
            setSavedAt(saved.savedAt);
          } else {
            setSavedAt(null);
            setError(
              isApiUnreachable(err) ? "You're offline, and this view hasn't been saved on this device." : message
            );
          }
        }
      } finally {
        if (!cancelled) {
          hasLoadedRef.current = true;
          setHasLoaded(true);
          setLoading(false);
        }
      }
    }
    void fetchPolishesPage();

    return () => {
      cancelled = true;
    };
  }, [listState, page, pageSize, toneFilter, retryTick]);

  // Once per saved copy shown (a retry that fails again keeps the same copy).
  useEffect(() => {
    if (savedAt !== null) {
      trackCollectionOfflineShown({ surface: "list", age: savedCopyAgeBucket(savedAt, Date.now()) });
    }
  }, [savedAt]);

  // Reset page when filters change (but keep initial URL-restored page). Compares against the
  // last seen filters instead of a "did mount" flag, so React Strict Mode's second effect run on
  // mount cannot reset a restored page either (#348).
  const filtersKey = JSON.stringify([
    debouncedSearch, statusesKey, untried, toneFilter, finishFilter, familyFilter, categoryFilter, sortKey, sortDirection,
  ]);
  const lastFiltersKeyRef = useRef(filtersKey);
  useEffect(() => {
    if (lastFiltersKeyRef.current === filtersKey) return;
    lastFiltersKeyRef.current = filtersKey;
    if (skipNextPageResetRef.current) {
      skipNextPageResetRef.current = false;
      return;
    }
    setPage(1);
  }, [filtersKey]);

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

  const hasActiveFilters = listHasActiveFilters({ search, statuses, untried, toneFilter, finishFilter, familyFilter, categoryFilter });

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
  // Dupe hints (#265) for catalog and wishlist rows: one batch request per page, not per row.
  const dupeHints = useDupeHints(pageItems);
  // Add guard (#266): adding a not-owned shade shows its owned near-dupes first.
  const { guardAdd, active: activeGuard, choose: chooseGuard, isChecking: isGuardChecking } = useAddGuard();

  // Clamp a page past the end only once real data is in (#348): on mount `total` is still 0, and
  // clamping then rewrote a restored `?page=N` to page 1. A failed load keeps the page too.
  useEffect(() => {
    const nextPage = clampPageAfterLoad({ page, total, pageSize, hasLoaded: hasLoaded && !error, loading });
    if (nextPage !== null) setPage(nextPage); // eslint-disable-line react-hooks/set-state-in-effect
  }, [page, total, pageSize, hasLoaded, error, loading]);

  /** The archive toast's reason / Undo answers (D5c): replace the row, keeping its buyUrl. */
  const applyArchiveToastUpdate = useCallback((updated: Polish) => {
    setPolishes((prev) => prev.map((p) => (p.id === updated.id ? keepBuyUrl(updated, p) : p)));
  }, []);

  // Optimistic inventory update (stepper, add guard). Rollback only touches the row if no newer
  // change replaced it (see lib/collection-actions.ts).
  const applyInventoryChange = useCallback(
    (original: Polish, change: Pick<PolishUpdateRequest, "quantity" | "status">) => {
      const polishId = original.id;
      const optimistic = applyInventoryPatch(original, change);
      setPolishes((prev) => applyOptimistic(prev, polishId, optimistic));

      updatePolish(polishId, change)
        .then((updated) => {
          setPolishes((prev) => commitOptimistic(prev, polishId, optimistic, keepBuyUrl(updated, original)));
          if (change.status !== undefined && change.status !== original.status) {
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
    [applyArchiveToastUpdate]
  );

  const handleQuantityChange = useCallback(
    (polishId: string, delta: number) => {
      const original = polishes.find((p) => p.id === polishId);
      if (!original) return;

      if (delta > 0 && !isOwnedPolish(original)) {
        void guardAdd({
          guardKey: shadeGuardKey(original.id),
          shadeLabel: `${original.brand} ${original.name}`,
          status: original.status,
          intent: "own",
          surface: "polishes-list",
          hint: dupeHints[original.id],
          loadDupes: () => getPolishDupes(original.id),
          proceed: (intent) => {
            if (intent === "wishlist") {
              applyInventoryChange(original, wishlistInsteadUpdate());
              toast.success("Added to wishlist", {
                description: `${original.brand} ${original.name} is on your wishlist.`,
              });
              return;
            }
            applyInventoryChange(original, quantityChangeUpdate(original, delta));
          },
        });
        return;
      }

      applyInventoryChange(original, quantityChangeUpdate(original, delta));
    },
    [polishes, dupeHints, guardAdd, applyInventoryChange]
  );

  // Optimistic status / tried-date quick actions with rollback on error.
  const runCollectionAction = useCallback(
    (original: Polish, action: CollectionAction, source: QuickActionSource) => {
      const polishId = original.id;
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
    [applyArchiveToastUpdate]
  );

  const handleCollectionAction = useCallback(
    (polishId: string, action: CollectionAction, source: QuickActionSource) => {
      const original = polishes.find((p) => p.id === polishId);
      if (!original || actionPendingById[polishId]) return;

      // Add guard (#266): "✓ Own" / "♡ wishlist" on a shade the caller does not own yet shows its
      // owned near-dupes first, like the stepper's Add.
      const intent: AddGuardIntent | null =
        action.kind === "set-status" && !isOwnedPolish(original) && action.status !== original.status
          ? action.status === "owned"
            ? "own"
            : action.status === "wishlist"
              ? "wishlist"
              : null
          : null;
      if (!intent) {
        runCollectionAction(original, action, source);
        return;
      }

      void guardAdd({
        guardKey: shadeGuardKey(original.id),
        shadeLabel: `${original.brand} ${original.name}`,
        status: original.status,
        intent,
        surface: "polishes-list",
        hint: dupeHints[original.id],
        loadDupes: () => getPolishDupes(original.id),
        proceed: (finalIntent) => {
          runCollectionAction(
            original,
            finalIntent === "wishlist" ? { kind: "set-status", status: "wishlist" } : action,
            source
          );
        },
      });
    },
    [actionPendingById, polishes, dupeHints, guardAdd, runCollectionAction]
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

  const clearAllFilters = () => {
    setSearch("");
    setStatuses([]);
    setUntried(false);
    setToneFilter("all");
    setFinishFilter("all");
    setFamilyFilter("");
    setCategoryFilter("");
  };

  // Empty collection/wishlist → every polish, with the search box ready to type in.
  const browseCatalog = () => {
    setStatuses([]);
    setUntried(false);
    requestAnimationFrame(() => searchInputRef.current?.focus());
  };

  const showEmptyState = hasLoaded && pageItems.length === 0;

  // Full-page spinner only before the first result: unmounting the page on every refetch
  // would drop the search input (and its focus) mid-typing.
  if (loading && !hasLoaded) {
    return <BrandSpinner label="Loading polishes…" />;
  }

  if (error) {
    return <ErrorState message={error} onRetry={() => window.location.reload()} />;
  }

  // Row actions shared by the desktop table and the mobile cards, so both layouts use the same
  // handlers (add guard, optimistic updates, mani logging).
  const renderRowActions = (polish: Polish) => (
    <>
      {isOwnedPolish(polish) && <LogManiButton polish={polish} variant="icon" disabled={offline} />}
      <CollectionQuickActions
        polish={polish}
        pending={offline || actionPendingById[polish.id] === true || isGuardChecking(shadeGuardKey(polish.id))}
        onAction={(action, source) => handleCollectionAction(polish.id, action, source)}
        onQuantityChange={(delta) => handleQuantityChange(polish.id, delta)}
      />
    </>
  );

  return (
    <div className="space-y-4">
      {/* Page header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="heading-page">All Polishes</h1>
          <p className="text-muted-foreground">
            {total} polishes &middot; {polishes.length} shown
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <PickForMeButton disabled={offline} />
          <CollectionExportMenu disabled={offline} />
          {offline ? (
            <>
              <Button variant="outline" disabled>
                <Upload aria-hidden="true" />
                Import
              </Button>
              <Button disabled>+ Add Polish</Button>
            </>
          ) : (
            <>
              <Button asChild variant="outline">
                <Link href="/polishes/import">
                  <Upload aria-hidden="true" />
                  Import
                </Link>
              </Button>
              <Button asChild>
                <Link href="/polishes/new">+ Add Polish</Link>
              </Button>
            </>
          )}
        </div>
      </div>

      {savedAt !== null && (
        <SavedCopyBanner savedAt={savedAt} subject="collection" retrying={loading} onRetry={retryNow} />
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <Input
          ref={searchInputRef}
          autoFocus={focusSearchOnLoad}
          aria-label="Search polishes"
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
            onClick={clearAllFilters}
          >
            Clear filters
          </Button>
        )}
      </div>

      <ColorFamilyChips
        value={selectedFamilies}
        onChange={(next) => setFamilyFilter(serializeColorFamilies(next))}
      />
      <ProductCategoryChips value={selectedCategories} onChange={(next) => setCategoryFilter(next.join(","))} />
      {/* Opt-in public wishlist link (#268); hidden unless the server flag is on. */}
      {statusPresetFor(statuses) === "wishlist" && <WishlistShareCard />}
      {/* What the wishlist adds up to (brand list prices, per currency; all wishlist rows, not the page). */}
      {statusPresetFor(statuses) === "wishlist" && <WishlistValue refreshKey={total} />}

      {showEmptyState && (
        <PolishesEmptyState
          kind={polishesEmptyStateKind({ search, statuses, untried, toneFilter, finishFilter, familyFilter })}
          onBrowseCatalog={browseCatalog}
          onClearFilters={clearAllFilters}
        />
      )}

      {/* Table (replaced by the empty state above: a full-width table cell clips it on phones) */}
      <div
        className={`relative overflow-hidden rounded-lg border transition-opacity ${
          loading ? "opacity-60" : ""
        } ${showEmptyState ? "hidden" : ""}`}
        aria-busy={loading}
      >
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 w-1 bg-gradient-to-b from-brand-pink-soft via-brand-lilac to-brand-purple"
        />
        {/* Phones: one card per polish with its actions inline (below md). */}
        <div className="md:hidden">
          <div className="flex items-center gap-2 border-b border-border/60 py-2 pl-4 pr-3">
            <span className="text-xs font-medium text-muted-foreground">Sort</span>
            <Select value={sortKey} onValueChange={(v) => setSortKey(v as SortKey)}>
              <SelectTrigger className="h-8 w-[140px]" aria-label="Sort polishes by">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MOBILE_SORT_OPTIONS.map((option) => (
                  <SelectItem key={option.key} value={option.key}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              aria-label={sortDirection === "asc" ? "Sorted ascending, switch to descending" : "Sorted descending, switch to ascending"}
              onClick={() => setSortDirection((d) => (d === "asc" ? "desc" : "asc"))}
            >
              {sortDirection === "asc" ? <ArrowUp aria-hidden="true" /> : <ArrowDown aria-hidden="true" />}
            </Button>
          </div>
          {pageItems.length === 0 ? null : (
            <ul className="divide-y divide-border/60" aria-label="Polishes">
              {pageItems.map((polish) => {
                const recalcPending = recalcPendingById[polish.id] === true;
                const dupeHint = isOwnedPolish(polish) ? undefined : dupeHints[polish.id];
                const dupeLabel = dupeHintLabel(dupeHint);
                const displayHex = resolveDisplayHex(polish);
                return (
                  <li key={polish.id} className="space-y-2 py-3 pl-4 pr-3" data-testid="polish-card">
                    <div className="flex items-start gap-3">
                      {polish.swatchImageUrl ? (
                        <a
                          href={polish.swatchImageUrl}
                          target="_blank"
                          rel="noreferrer"
                          aria-label={`Open ${polish.brand} ${polish.name} swatch image in new tab`}
                          className="shrink-0"
                        >
                          <SwatchThumbnail
                            src={polish.swatchImageUrl}
                            displaySize={48}
                            alt={`${polish.brand} ${polish.name} swatch`}
                            className="h-12 w-12 rounded-md border object-cover"
                          />
                        </a>
                      ) : (
                        <div className="h-12 w-12 shrink-0 rounded-md border bg-muted/40" />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs text-muted-foreground">{polish.brand}</p>
                        <Link
                          href={`/polishes/detail?id=${polish.id}&returnTo=${encodeURIComponent(returnToHref)}`}
                          className="break-words font-medium text-primary hover:underline"
                        >
                          {polish.name}
                        </Link>
                        <div className="mt-1 flex flex-wrap items-center gap-1">
                          <StatusChip status={polish.status} />
                          {polish.isUntried && <UntriedBadge />}
                          <FinishBadges polish={polish} finishTypes={finishTypes} max={2} />
                        </div>
                        {(polish.buyUrl || (dupeLabel && dupeHint?.best)) && (
                          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                            <BuyFromBrandLink
                              url={polish.buyUrl}
                              brand={polish.brand}
                              name={polish.name}
                              price={isOwnedPolish(polish) ? null : polish}
                              className="flex w-fit"
                            />
                            {dupeLabel && dupeHint?.best && (
                              <Link
                                href={dupeHref(dupeHint.best, returnToHref)}
                                title={dupeHintTitle(dupeHint) ?? undefined}
                                aria-label={dupeHintTitle(dupeHint) ?? dupeLabel}
                                className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none ${DUPE_GRADE_META[dupeHint.best.grade].badgeClassName}`}
                              >
                                <ColorDot hex={dupeHint.best.displayHex} size="sm" className="h-2.5 w-2.5" />
                                {dupeLabel}
                              </Link>
                            )}
                          </div>
                        )}
                      </div>
                      <ColorDot
                        hex={displayHex}
                        size="md"
                        className="shrink-0 ring-2 ring-white/80 shadow-[0_0_0_1px_rgba(66,16,126,0.18),0_8px_20px_rgba(66,16,126,0.16)]"
                      />
                    </div>
                    <div className="flex flex-wrap items-center justify-end gap-1">
                      {displayHex && (
                        <Link
                          href={`/polishes/search?color=${displayHex.replace("#", "")}`}
                          className="mr-auto inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:text-primary"
                          aria-label={`Find colors similar to ${polish.name}`}
                        >
                          <span aria-hidden="true">🔍</span> Similar
                        </Link>
                      )}
                      {isAdmin && (
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          disabled={recalcPending || offline}
                          onClick={() => handleRecalcHex(polish.id)}
                        >
                          {recalcPending ? <Loader2 className="size-3 animate-spin" /> : <Sparkles className="size-3" />}
                          {recalcPending ? "Submitting..." : "Recalc"}
                        </Button>
                      )}
                      {renderRowActions(polish)}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* md and up: the full sortable table. */}
        <div className="hidden md:block">
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
            {pageItems.length === 0 ? null : (
              pageItems.map((polish) => {
                const recalcPending = recalcPendingById[polish.id] === true;
                const owned = isOwnedPolish(polish);
                const dupeHint = owned ? undefined : dupeHints[polish.id];
                const dupeLabel = dupeHintLabel(dupeHint);
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
                          <SwatchThumbnail
                            src={polish.swatchImageUrl}
                            displaySize={40}
                            alt={`${polish.brand} ${polish.name} swatch`}
                            className="h-10 w-10 rounded-md border object-cover transition-opacity hover:opacity-85"
                          />
                        </a>
                      ) : (
                        <div className="h-10 w-10 rounded-md border bg-muted/40" />
                      )}
                    </TableCell>
                    <TableCell className="font-medium">{polish.brand}</TableCell>
                    <TableCell className="whitespace-normal">
                      {/* Name block (name + buy link) on the left, descriptor pills right-aligned (#350). DOM order stays name -> buy link -> pills. */}
                      <div className="flex items-start gap-2">
                        <div className="min-w-0 flex-1">
                          <Link
                            href={detailHref(polish.id, returnToHref)}
                            className="break-words text-primary hover:underline"
                          >
                            {polish.name}
                          </Link>
                          <ProductCategoryPill category={polish.productCategory} className="ml-1.5 align-middle" />
                          <BuyFromBrandLink
                            url={polish.buyUrl}
                            brand={polish.brand}
                            name={polish.name}
                            price={isOwnedPolish(polish) ? null : polish}
                            className="mt-0.5 flex w-fit"
                          />
                        </div>
                        {dupeLabel && dupeHint?.best && (
                          <div className="ml-auto flex shrink-0 flex-wrap justify-end gap-1">
                            <Link
                              href={dupeHref(dupeHint.best, returnToHref)}
                              title={dupeHintTitle(dupeHint) ?? undefined}
                              aria-label={dupeHintTitle(dupeHint) ?? dupeLabel}
                              className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none ${DUPE_GRADE_META[dupeHint.best.grade].badgeClassName}`}
                            >
                              <ColorDot hex={dupeHint.best.displayHex} size="sm" className="h-2.5 w-2.5" />
                              {dupeLabel}
                            </Link>
                          </div>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      {showsTopperSwatch(polish.productCategory) ? (
                        <TopperSwatch size="md" />
                      ) : (
                        <ColorDot
                          hex={resolveDisplayHex(polish)}
                          size="md"
                          className="ring-2 ring-white/80 shadow-[0_0_0_1px_rgba(66,16,126,0.18),0_8px_20px_rgba(66,16,126,0.16)]"
                        />
                      )}
                    </TableCell>
                    <TableCell className="text-center">
                      {resolveDisplayHex(polish) && !showsTopperSwatch(polish.productCategory) && (
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
                          disabled={recalcPending || offline}
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
                        {renderRowActions(polish)}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
        </div>
      </div>

      <AddGuardDialog guard={activeGuard} onChoice={chooseGuard} returnTo={returnToHref} />

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
