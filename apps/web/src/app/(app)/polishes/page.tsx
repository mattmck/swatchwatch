"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { Polish } from "swatchwatch-shared";
import { resolveDisplayHex } from "swatchwatch-shared";
import { listAllPolishes, recalcPolishHex, updatePolish } from "@/lib/api";
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
import { ToggleChip } from "@/components/toggle-chip";
import { BrandSpinner } from "@/components/brand-spinner";
import { ErrorState } from "@/components/error-state";
import { EmptyState } from "@/components/empty-state";
import { FINISHES, finishBadgeClassName, finishLabel } from "@/lib/constants";
import { useAuth, useDevAuth, useUnconfiguredAuth } from "@/hooks/use-auth";
import { buildMsalConfig } from "@/lib/msal-config";
import { toast } from "sonner";

const DEFAULT_PAGE_SIZE = 10;
const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;
type SortKey = "status" | "brand" | "name" | "finish" | "collection";
type SortDirection = "asc" | "desc";
type AvailabilityFilter = "all" | "owned" | "wishlist";
const SORT_KEYS: readonly SortKey[] = ["status", "brand", "name", "finish", "collection"];
const IS_DEV_BYPASS = process.env.NEXT_PUBLIC_AUTH_DEV_BYPASS === "true";
const HAS_B2C_CONFIG = buildMsalConfig() !== null;

/**
 * Parse a string into a positive integer, returning a fallback when the input is absent or invalid.
 *
 * @param value - The string to parse (commonly a URL query parameter); may be null.
 * @param fallback - The value to return when `value` is missing or does not represent an integer greater than zero.
 * @returns The parsed integer if it is greater than zero, otherwise `fallback`.
 */
function parsePositiveInt(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Parse a boolean-like query flag string into a boolean.
 *
 * Accepts the strings `"1"` and `"true"` as true, and `"0"` and `"false"` as false.
 *
 * @param value - The input string (often from a query parameter); may be `null`
 * @param fallback - Value to return when `value` is `null` or not recognized
 * @returns `true` if `value` is `"1"` or `"true"`, `false` if `value` is `"0"` or `"false"`, otherwise `fallback`
 */
function parseBooleanFlag(value: string | null, fallback: boolean): boolean {
  if (!value) return fallback;
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  return fallback;
}

/**
 * Normalize a string into a valid sort key.
 *
 * @param value - Candidate sort key (e.g., from user input or URL); may be `null`
 * @returns The input `value` if it matches a known sort key, otherwise `name`
 */
function parseSortKey(value: string | null): SortKey {
  return SORT_KEYS.includes(value as SortKey) ? (value as SortKey) : "name";
}

/**
 * Normalize a sort direction string to either "asc" or "desc".
 *
 * @param value - Input sort direction; the string `"desc"` is preserved, all other values (including `null`) map to `"asc"`.
 * @returns `"desc"` if `value` is `"desc"`, `"asc"` otherwise.
 */
function parseSortDirection(value: string | null): SortDirection {
  return value === "desc" ? "desc" : "asc";
}

/**
 * Normalize a raw tone filter string into a valid undertone value or "all".
 *
 * @param value - The raw filter string (may be `null`) typically from a query parameter
 * @returns `warm`, `cool`, or `neutral` when `value` matches one of those; `all` otherwise
 */
function parseToneFilter(value: string | null): Undertone | "all" {
  return value === "warm" || value === "cool" || value === "neutral" ? value : "all";
}

/**
 * Validate and normalize a finish filter value.
 *
 * @param value - Raw finish filter value (e.g., from a query parameter); may be a finish name or `"all"`.
 * @returns The original finish name if it is one of the known finishes, otherwise `"all"`.
 */
function parseFinishFilter(value: string | null): string {
  if (!value || value === "all") return "all";
  return FINISHES.includes(value as (typeof FINISHES)[number]) ? value : "all";
}

/**
 * Parse a query string into a valid availability filter.
 *
 * @param value - The raw input to interpret; expected values are `"owned"` or `"wishlist"`. `null` or any other string will be treated as no filter.
 * @returns The parsed availability filter: `"owned"`, `"wishlist"`, or `"all"`.
 */
function parseAvailabilityFilter(value: string | null): AvailabilityFilter {
  return value === "owned" || value === "wishlist" ? value : "all";
}

/**
 * Parse and validate a page-size query value against the allowed page-size options.
 *
 * @param value - The raw page-size string (e.g., from a URL query) or null
 * @returns A valid page size from `PAGE_SIZE_OPTIONS`; `DEFAULT_PAGE_SIZE` if the input is missing or invalid
 */
function parsePageSize(value: string | null): number {
  const parsed = parsePositiveInt(value, DEFAULT_PAGE_SIZE);
  return PAGE_SIZE_OPTIONS.includes(parsed as (typeof PAGE_SIZE_OPTIONS)[number])
    ? parsed
    : DEFAULT_PAGE_SIZE;
}

/**
 * Renders the appropriate polishes page variant based on environment and authentication configuration.
 *
 * @returns The React element for the developer bypass page when developer bypass is enabled, the unconfigured page when B2C auth is not configured, or the B2C-enabled polishes page otherwise.
 */
export default function PolishesPage() {
  if (IS_DEV_BYPASS) {
    return <DevPolishesPage />;
  }

  if (!HAS_B2C_CONFIG) {
    return <UnconfiguredPolishesPage />;
  }

  return <B2CPolishesPage />;
}

function DevPolishesPage() {
  const { isAdmin } = useDevAuth();
  return <PolishesPageContent isAdmin={isAdmin} />;
}

function B2CPolishesPage() {
  const { isAdmin } = useAuth();
  return <PolishesPageContent isAdmin={isAdmin} />;
}

/**
 * Render the polishes page for environments without B2C configuration.
 *
 * @returns A JSX element that renders PolishesPageContent with the `isAdmin` flag obtained from the unconfigured auth hook.
 */
function UnconfiguredPolishesPage() {
  const { isAdmin } = useUnconfiguredAuth();
  return <PolishesPageContent isAdmin={isAdmin} />;
}

/**
 * Render the "All Polishes" page: a searchable, filterable, sortable and paginated list of polishes with inline actions.
 *
 * The component initializes list state from the URL query parameters and keeps the URL in sync as filters,
 * sorting, or pagination change. It fetches polishes on mount, shows loading and error states, applies
 * text/tone/finish/availability filters, supports stable sorting and optional favoring of owned items,
 * and provides optimistic quantity updates. When `isAdmin` is true, admin-only actions (Recalc Hex) are exposed.
 *
 * @param isAdmin - If true, include admin-only controls (e.g., Recalc Hex) in the UI.
 * @returns The page's React element containing header, filter controls, table of polishes, and pagination.
 */
function PolishesPageContent({ isAdmin }: { isAdmin: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const didMountRef = useRef(false);
  const [polishes, setPolishes] = useState<Polish[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [search, setSearch] = useState(() => searchParams.get("q") ?? "");
  const [favorCollection, setFavorCollection] = useState(() =>
    parseBooleanFlag(searchParams.get("favor"), true)
  );
  const [includeAll, setIncludeAll] = useState(() =>
    parseBooleanFlag(searchParams.get("all"), true)
  );
  const [toneFilter, setToneFilter] = useState<Undertone | "all">(() =>
    parseToneFilter(searchParams.get("tone"))
  );
  const [finishFilter, setFinishFilter] = useState<string>(() =>
    parseFinishFilter(searchParams.get("finish"))
  );
  const [availabilityFilter, setAvailabilityFilter] = useState<AvailabilityFilter>(() =>
    parseAvailabilityFilter(searchParams.get("avail"))
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

  useEffect(() => {
    let cancelled = false;

    async function fetchPolishes() {
      try {
        setLoading(true);
        setError(null);

        const allPolishes = await listAllPolishes({
          sortBy: "createdAt",
          sortOrder: "desc",
        });

        if (!cancelled) {
          setPolishes(allPolishes);
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
    fetchPolishes();

    return () => {
      cancelled = true;
    };
  }, []);

  // Reset page when filters change (but keep initial URL-restored page).
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    setPage(1);
  }, [search, favorCollection, includeAll, toneFilter, finishFilter, availabilityFilter, sortKey, sortDirection]);

  // Persist list state in URL to support back/forward restoration.
  useEffect(() => {
    const params = new URLSearchParams();

    if (search) params.set("q", search);
    if (!favorCollection) params.set("favor", "0");
    if (!includeAll) params.set("all", "0");
    if (toneFilter !== "all") params.set("tone", toneFilter);
    if (finishFilter !== "all") params.set("finish", finishFilter);
    if (availabilityFilter !== "all") params.set("avail", availabilityFilter);
    if (sortKey !== "name") params.set("sort", sortKey);
    if (sortDirection !== "asc") params.set("dir", sortDirection);
    if (page !== 1) params.set("page", String(page));
    if (pageSize !== DEFAULT_PAGE_SIZE) params.set("pageSize", String(pageSize));

    const nextQuery = params.toString();
    const currentQuery = searchParams.toString();
    if (nextQuery === currentQuery) return;

    router.replace(nextQuery ? `${pathname}?${nextQuery}` : pathname, {
      scroll: false,
    });
  }, [
    availabilityFilter,
    favorCollection,
    finishFilter,
    includeAll,
    page,
    pageSize,
    pathname,
    router,
    search,
    searchParams,
    sortDirection,
    sortKey,
    toneFilter,
  ]);

  const isOwned = (p: Polish) => (p.quantity ?? 0) > 0;

  const filtered = useMemo(() => {
    let result = polishes;

    // Text search
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.brand.toLowerCase().includes(q) ||
          (p.color && p.color.toLowerCase().includes(q)) ||
          (p.collection && p.collection.toLowerCase().includes(q)) ||
          (p.notes && p.notes.toLowerCase().includes(q))
      );
    }

    // Include All unchecked = owned only
    if (!includeAll) {
      result = result.filter(isOwned);
    }

    if (toneFilter !== "all") {
      result = result.filter((p) => {
        const hex = resolveDisplayHex(p);
        return hex && undertone(hex) === toneFilter;
      });
    }

    if (finishFilter !== "all") {
      result = result.filter((p) => p.finish === finishFilter);
    }

    if (availabilityFilter !== "all") {
      result = result.filter((p) =>
        availabilityFilter === "owned" ? isOwned(p) : !isOwned(p)
      );
    }

    return result;
  }, [polishes, search, includeAll, toneFilter, finishFilter, availabilityFilter]);

  const sorted = useMemo(() => {
    const result = [...filtered];

    const normalize = (value: string | null | undefined) => (value ?? "").toLowerCase();
    const compare = (a: Polish, b: Polish): number => {
      switch (sortKey) {
        case "status": {
          const aOwned = isOwned(a) ? 0 : 1;
          const bOwned = isOwned(b) ? 0 : 1;
          return aOwned - bOwned;
        }
        case "brand":
          return normalize(a.brand).localeCompare(normalize(b.brand));
        case "name":
          return normalize(a.name).localeCompare(normalize(b.name));
        case "finish":
          return normalize(a.finish).localeCompare(normalize(b.finish));
        case "collection":
          return normalize(a.collection).localeCompare(normalize(b.collection));
        default:
          return 0;
      }
    };

    result.sort((a, b) => {
      const primary = compare(a, b);
      if (primary !== 0) return sortDirection === "asc" ? primary : -primary;

      const byName = normalize(a.name).localeCompare(normalize(b.name));
      if (byName !== 0) return byName;
      return normalize(a.brand).localeCompare(normalize(b.brand));
    });

    // Favor My Collection: stable-sort owned to top
    if (favorCollection) {
      result.sort((a, b) => {
        const aOwned = isOwned(a) ? 0 : 1;
        const bOwned = isOwned(b) ? 0 : 1;
        return aOwned - bOwned;
      });
    }

    return result;
  }, [filtered, favorCollection, sortKey, sortDirection]);

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

  const totalPages = Math.ceil(sorted.length / pageSize);
  const pageItems = sorted.slice((page - 1) * pageSize, page * pageSize);
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
    setRecalcPendingById((prev) => ({ ...prev, [polishId]: true }));
    try {
      const result = await recalcPolishHex(polishId);
      toast.success(result.message || "Hex recalculation request submitted.");
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Failed to recalculate shade hex.";
      toast.error("Hex recalculation failed", { description: message });
    } finally {
      setRecalcPendingById((prev) => {
        const next = { ...prev };
        delete next[polishId];
        return next;
      });
    }
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
            {polishes.length} polishes &middot; {sorted.length} shown
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

        <ToggleChip
          pressed={favorCollection}
          onPressedChange={setFavorCollection}
          aria-label="Toggle favor my collection"
          className="min-w-[180px]"
        >
          Favor My Collection
        </ToggleChip>

        <ToggleChip
          pressed={includeAll}
          onPressedChange={setIncludeAll}
          aria-label="Toggle include all polishes"
          className="min-w-[150px]"
        >
          Include All
        </ToggleChip>

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
              {FINISHES.map((finish) => (
                <SelectItem key={finish} value={finish}>
                  {finish.charAt(0).toUpperCase() + finish.slice(1)}
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
          !includeAll ||
          !favorCollection ||
          toneFilter !== "all" ||
          finishFilter !== "all" ||
          availabilityFilter !== "all") && (
          <Button
            variant="ghost"
            size="sm"
            className="text-brand-purple hover:bg-brand-pink-light/30"
            onClick={() => {
              setSearch("");
              setIncludeAll(true);
              setFavorCollection(true);
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
                  title="Sort by status"
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
                  title="Sort by brand"
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
                  title="Sort by name"
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
                  title="Sort by finish"
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
                  title="Sort by collection"
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
                    title={polishes.length === 0 ? "No polishes yet" : "No matches"}
                    description={polishes.length === 0 ? "Add your first polish to get started." : "Try adjusting your filters."}
                    actionLabel={polishes.length === 0 ? "+ Add Polish" : undefined}
                    actionHref={polishes.length === 0 ? "/polishes/new" : undefined}
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
                      {owned ? "\u2714\uFE0F" : "\u2795"}
                    </TableCell>
                    <TableCell>
                      {polish.swatchImageUrl ? (
                        <a
                          href={polish.swatchImageUrl}
                          target="_blank"
                          rel="noreferrer"
                          title="Open image"
                          className="inline-block"
                        >
                          <Image
                            src={polish.swatchImageUrl}
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
                        href={`/polishes/detail?id=${polish.id}`}
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
                          title="Find similar colors"
                        >
                          🔍
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
        totalItems={sorted.length}
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