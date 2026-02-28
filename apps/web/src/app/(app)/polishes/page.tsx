"use client";

import { Suspense, useState, useEffect, useMemo, useCallback, useRef } from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { Polish, PolishFilters } from "swatchwatch-shared";
import { resolveDisplayHex } from "swatchwatch-shared";
import { listAllPolishes, listPolishes, recalcPolishHex, updatePolish } from "@/lib/api";
import { undertone, type Undertone } from "@/lib/color-utils";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import { ArrowDown, ArrowUp, ArrowUpDown, Loader2, Sparkles } from "lucide-react";
import { ColorDot } from "@/components/color-dot";
import { QuantityControls } from "@/components/quantity-controls";
import { Pagination } from "@/components/pagination";
import { BrandSpinner } from "@/components/brand-spinner";
import { ErrorState } from "@/components/error-state";
import { EmptyState } from "@/components/empty-state";
import { FINISHES, finishBadgeClassName, finishLabel } from "@/lib/constants";
import { buildSwatchThumbnailUrl } from "@/lib/image-url";
import { runRecalcHexFlow } from "@/lib/recalc-hex-flow";
import { useAuth, useDevAuth, useUnconfiguredAuth } from "@/hooks/use-auth";
import { useReferenceData } from "@/hooks/use-reference-data";
import { buildMsalConfig } from "@/lib/msal-config";
import { toast } from "sonner";

const DEFAULT_PAGE_SIZE = 10;
const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;
type SortKey = "status" | "brand" | "name" | "finish" | "collection";
type SortDirection = "asc" | "desc";
type AvailabilityFilter = "all" | "owned" | "wishlist";
type ResultsScope = "all" | "collection";
const SORT_KEYS: readonly SortKey[] = ["status", "brand", "name", "finish", "collection"];
const IS_DEV_BYPASS = process.env.NEXT_PUBLIC_AUTH_DEV_BYPASS === "true";
const HAS_B2C_CONFIG = buildMsalConfig() !== null;

function parsePositiveInt(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBooleanFlag(value: string | null, fallback: boolean): boolean {
  if (!value) return fallback;
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  return fallback;
}

function parseSortKey(value: string | null): SortKey {
  return SORT_KEYS.includes(value as SortKey) ? (value as SortKey) : "name";
}

function parseSortDirection(value: string | null): SortDirection {
  return value === "desc" ? "desc" : "asc";
}

function parseToneFilter(value: string | null): Undertone | "all" {
  return value === "warm" || value === "cool" || value === "neutral" ? value : "all";
}

function parseFinishFilter(value: string | null): string {
  if (!value || value === "all") return "all";
  return value;
}

function parseAvailabilityFilter(value: string | null): AvailabilityFilter {
  return value === "owned" || value === "wishlist" ? value : "all";
}

function parseResultsScope(
  scopeValue: string | null,
  legacyIncludeAllValue: string | null
): ResultsScope {
  if (scopeValue === "collection") return "collection";
  if (scopeValue === "all") return "all";
  return parseBooleanFlag(legacyIncludeAllValue, true) ? "all" : "collection";
}

function parsePageSize(value: string | null): number {
  const parsed = parsePositiveInt(value, DEFAULT_PAGE_SIZE);
  return PAGE_SIZE_OPTIONS.includes(parsed as (typeof PAGE_SIZE_OPTIONS)[number])
    ? parsed
    : DEFAULT_PAGE_SIZE;
}

function toApiSortBy(sortKey: SortKey): PolishFilters["sortBy"] {
  switch (sortKey) {
    case "status":
    case "brand":
    case "name":
    case "finish":
    case "collection":
      return sortKey;
    default:
      return "name";
  }
}

type PolishesListQueryState = {
  search: string;
  scope: ResultsScope;
  toneFilter: Undertone | "all";
  finishFilter: string;
  availabilityFilter: AvailabilityFilter;
  sortKey: SortKey;
  sortDirection: SortDirection;
  page: number;
  pageSize: number;
};

function buildPolishesListQueryString(state: PolishesListQueryState): string {
  const params = new URLSearchParams();
  if (state.search) params.set("q", state.search);
  if (state.scope !== "all") params.set("scope", state.scope);
  if (state.toneFilter !== "all") params.set("tone", state.toneFilter);
  if (state.finishFilter !== "all") params.set("finish", state.finishFilter);
  if (state.availabilityFilter !== "all") params.set("availability", state.availabilityFilter);
  if (state.sortKey !== "name") params.set("sort", state.sortKey);
  if (state.sortDirection !== "asc") params.set("dir", state.sortDirection);
  if (state.page !== 1) params.set("page", String(state.page));
  if (state.pageSize !== DEFAULT_PAGE_SIZE) params.set("pageSize", String(state.pageSize));
  return params.toString();
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
  const didMountRef = useRef(false);
  const [polishes, setPolishes] = useState<Polish[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { finishTypes } = useReferenceData();
  const finishOptions = useMemo(
    () =>
      (
        finishTypes.length > 0
          ? finishTypes.map((finish) => ({ value: finish.name, label: finish.displayName }))
          : FINISHES.map((finish) => ({ value: finish, label: finishLabel(finish) }))
      ).sort((a, b) => a.label.localeCompare(b.label)),
    [finishTypes],
  );

  // Filters
  const [search, setSearch] = useState(() => searchParams.get("q") ?? "");
  const [scope, setScope] = useState<ResultsScope>(() =>
    parseResultsScope(searchParams.get("scope"), searchParams.get("all"))
  );
  const [toneFilter, setToneFilter] = useState<Undertone | "all">(() =>
    parseToneFilter(searchParams.get("tone"))
  );
  const [finishFilter, setFinishFilter] = useState<string>(() =>
    parseFinishFilter(searchParams.get("finish"))
  );
  const [availabilityFilter, setAvailabilityFilter] = useState<AvailabilityFilter>(() =>
    parseAvailabilityFilter(searchParams.get("availability") ?? searchParams.get("avail"))
  );
  const [sortKey, setSortKey] = useState<SortKey>(() =>
    parseSortKey(searchParams.get("sort"))
  );
  const [sortDirection, setSortDirection] = useState<SortDirection>(() =>
    parseSortDirection(searchParams.get("dir"))
  );

  // Pagination
  const [page, setPage] = useState(() => parsePositiveInt(searchParams.get("page"), 1));
  const [pageSize, setPageSize] = useState(() =>
    parsePageSize(searchParams.get("pageSize"))
  );
  const [recalcPendingById, setRecalcPendingById] = useState<
    Record<string, boolean>
  >({});
  const [debouncedSearch, setDebouncedSearch] = useState(() => searchParams.get("q") ?? "");

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDebouncedSearch(search);
    }, 200);
    return () => window.clearTimeout(timeoutId);
  }, [search]);

  useEffect(() => {
    let cancelled = false;

    async function fetchPolishesPage() {
      try {
        setLoading(true);
        setError(null);

        const baseFilters: Omit<PolishFilters, "page" | "pageSize" | "tone"> = {
          search: debouncedSearch.trim() || undefined,
          finish: finishFilter !== "all" ? (finishFilter as PolishFilters["finish"]) : undefined,
          scope,
          availability: availabilityFilter,
          sortBy: toApiSortBy(sortKey),
          sortOrder: sortDirection,
        };

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
          setLoading(false);
        }
      }
    }
    void fetchPolishesPage();

    return () => {
      cancelled = true;
    };
  }, [
    availabilityFilter,
    debouncedSearch,
    finishFilter,
    page,
    pageSize,
    scope,
    sortDirection,
    sortKey,
    toneFilter,
  ]);

  // Reset page when filters change (but keep initial URL-restored page).
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    setPage(1);
  }, [search, scope, toneFilter, finishFilter, availabilityFilter, sortKey, sortDirection]);

  const queryString = useMemo(
    () =>
      buildPolishesListQueryString({
        search,
        scope,
        toneFilter,
        finishFilter,
        availabilityFilter,
        sortKey,
        sortDirection,
        page,
        pageSize,
      }),
    [
      search,
      scope,
      toneFilter,
      finishFilter,
      availabilityFilter,
      sortKey,
      sortDirection,
      page,
      pageSize,
    ]
  );
  const returnToHref = queryString ? `${pathname}?${queryString}` : pathname;

  // Persist list state in URL to support back/forward restoration.
  useEffect(() => {
    const nextQuery = queryString;
    const currentQuery = searchParams.toString();
    if (nextQuery === currentQuery) return;

    router.replace(nextQuery ? `${pathname}?${nextQuery}` : pathname, {
      scroll: false,
    });
  }, [
    availabilityFilter,
    finishFilter,
    page,
    pageSize,
    pathname,
    queryString,
    router,
    searchParams,
  ]);

  const isOwned = (p: Polish) => (p.quantity ?? 0) > 0;
  const hasActiveFilters =
    search.trim().length > 0 ||
    scope !== "all" ||
    toneFilter !== "all" ||
    finishFilter !== "all" ||
    availabilityFilter !== "all";

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

  // Optimistic quantity update
  const handleQuantityChange = useCallback(
    (polishId: string, delta: number) => {
      const original = polishes.find((p) => p.id === polishId);
      if (!original) return;

      const newQty = Math.max(0, (original.quantity ?? 0) + delta);
      setPolishes((prev) =>
        prev.map((p) => (p.id === polishId ? { ...p, quantity: newQty } : p))
      );

      updatePolish(polishId, { quantity: newQty })
        .then((updated) => {
          setPolishes((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
        })
        .catch(() => {
          setPolishes((prev) =>
            prev.map((p) => (p.id === polishId ? original : p))
          );
        });
    },
    [polishes]
  );

  const handleRecalcHex = useCallback(async (polishId: string) => {
    await runRecalcHexFlow({
      polishId,
      recalc: recalcPolishHex,
      knownFinishes: FINISHES as readonly string[],
      setPendingById: setRecalcPendingById,
      setPolishes,
      toast,
    });
  }, []);

  if (loading) return <BrandSpinner label="Loading polishes…" />;

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
        <Button asChild>
          <Link href="/polishes/new">+ Add Polish</Link>
        </Button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <Input
          placeholder="Search by name, brand, or color..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-xs"
        />

        <div className="flex rounded-lg border bg-muted p-1">
          <Button
            variant={scope === "all" ? "default" : "ghost"}
            size="sm"
            onClick={() => setScope("all")}
          >
            All
          </Button>
          <Button
            variant={scope === "collection" ? "default" : "ghost"}
            size="sm"
            onClick={() => setScope("collection")}
          >
            My Collection
          </Button>
        </div>

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

          <Select
            value={availabilityFilter}
            onValueChange={(v) => setAvailabilityFilter(v as "all" | "owned" | "wishlist")}
          >
            <SelectTrigger className="h-8 w-[170px]">
              <SelectValue placeholder="Availability" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Items</SelectItem>
              <SelectItem value="owned">In Collection</SelectItem>
              <SelectItem value="wishlist">Wishlist</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {(search ||
          scope !== "all" ||
          toneFilter !== "all" ||
          finishFilter !== "all" ||
          availabilityFilter !== "all") && (
          <Button
            variant="ghost"
            size="sm"
            className="text-brand-purple hover:bg-brand-pink-light/30"
            onClick={() => {
              setSearch("");
              setScope("all");
              setToneFilter("all");
              setFinishFilter("all");
              setAvailabilityFilter("all");
            }}
          >
            Clear filters
          </Button>
        )}
      </div>

      {/* Table */}
      <div className="relative overflow-hidden rounded-lg border">
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 w-1 bg-gradient-to-b from-brand-pink-soft via-brand-lilac to-brand-purple"
        />
        <Table>
          <TableHeader className="sticky top-0 z-10">
            <TableRow className="glass border-b border-border/60">
              <TableHead className="w-10" aria-sort={getAriaSort("status")}>
                <button
                  type="button"
                  className="flex w-full items-center justify-center gap-1 text-xs font-medium"
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
              <TableHead className="w-28 text-right">Action</TableHead>
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
                const owned = isOwned(polish);
                const recalcPending = recalcPendingById[polish.id] === true;
                return (
                  <TableRow
                    key={polish.id}
                    className="transition-colors hover:bg-brand-pink-light/20"
                  >
                    <TableCell className="text-center text-lg">
                      <span aria-label={owned ? "In collection" : "Not in collection"}>
                        {owned ? "\u2714\uFE0F" : "\u2795"}
                      </span>
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
                      {polish.finish && (
                        <Badge className={finishBadgeClassName(polish.finish)}>
                          {finishLabel(polish.finish)}
                        </Badge>
                      )}
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
                      <QuantityControls
                        quantity={polish.quantity ?? 0}
                        onIncrement={() => handleQuantityChange(polish.id, 1)}
                        onDecrement={() => handleQuantityChange(polish.id, -1)}
                        onAdd={() => handleQuantityChange(polish.id, 1)}
                      />
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
