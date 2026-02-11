"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import Link from "next/link";
import type { Polish } from "swatchwatch-shared";
import { listPolishes, updatePolish } from "@/lib/api";
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
import { ColorDot } from "@/components/color-dot";
import { QuantityControls } from "@/components/quantity-controls";
import { Pagination } from "@/components/pagination";
import { ToggleChip } from "@/components/toggle-chip";
import { BrandSpinner } from "@/components/brand-spinner";
import { ErrorState } from "@/components/error-state";
import { EmptyState } from "@/components/empty-state";
import { FINISHES, finishBadgeClassName, finishLabel } from "@/lib/constants";

const PAGE_SIZE = 10;

export default function PolishesPage() {
  const [polishes, setPolishes] = useState<Polish[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [search, setSearch] = useState("");
  const [favorCollection, setFavorCollection] = useState(true);
  const [includeAll, setIncludeAll] = useState(true);
  const [toneFilter, setToneFilter] = useState<Undertone | "all">("all");
  const [finishFilter, setFinishFilter] = useState<string>("all");
  const [availabilityFilter, setAvailabilityFilter] = useState<"all" | "owned" | "wishlist">("all");

  // Pagination
  const [page, setPage] = useState(1);

  useEffect(() => {
    async function fetchPolishes() {
      try {
        setLoading(true);
        const response = await listPolishes();
        setPolishes(response.polishes);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Failed to load polishes";
        setError(message);
      } finally {
        setLoading(false);
      }
    }
    fetchPolishes();
  }, []);

  // Reset page when filters change
  useEffect(() => {
    setPage(1);
  }, [search, favorCollection, includeAll, toneFilter, finishFilter, availabilityFilter]);

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
      result = result.filter((p) => p.colorHex && undertone(p.colorHex) === toneFilter);
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

    // Default alphabetical sort
    result.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

    // Favor My Collection: stable-sort owned to top
    if (favorCollection) {
      result.sort((a, b) => {
        const aOwned = isOwned(a) ? 0 : 1;
        const bOwned = isOwned(b) ? 0 : 1;
        return aOwned - bOwned;
      });
    }

    return result;
  }, [filtered, favorCollection]);

  const totalPages = Math.ceil(sorted.length / PAGE_SIZE);
  const pageItems = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // Optimistic quantity update
  const handleQuantityChange = useCallback(
    (polishId: string, delta: number) => {
      setPolishes((prev) =>
        prev.map((p) => {
          if (p.id !== polishId) return p;
          const newQty = Math.max(0, (p.quantity ?? 0) + delta);
          return { ...p, quantity: newQty };
        })
      );

      const polish = polishes.find((p) => p.id === polishId);
      if (!polish) return;
      const newQty = Math.max(0, (polish.quantity ?? 0) + delta);

      updatePolish(polishId, { id: polishId, quantity: newQty }).catch(() => {
        // Revert on failure
        setPolishes((prev) =>
          prev.map((p) => {
            if (p.id !== polishId) return p;
            return { ...p, quantity: polish.quantity };
          })
        );
      });
    },
    [polishes]
  );

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
              <TableHead className="w-10">Status</TableHead>
              <TableHead>Brand</TableHead>
              <TableHead>Name</TableHead>
              <TableHead className="w-14">Color</TableHead>
              <TableHead className="w-12">Find</TableHead>
              <TableHead>Finish</TableHead>
              <TableHead>Collection</TableHead>
              <TableHead className="w-28 text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pageItems.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="p-0">
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
                return (
                  <TableRow
                    key={polish.id}
                    className="transition-colors hover:bg-brand-pink-light/20"
                  >
                    <TableCell className="text-center text-lg">
                      {owned ? "\u2714\uFE0F" : "\u2795"}
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
                        hex={polish.colorHex}
                        size="md"
                        className="ring-2 ring-white/80 shadow-[0_0_0_1px_rgba(66,16,126,0.18),0_8px_20px_rgba(66,16,126,0.16)]"
                      />
                    </TableCell>
                    <TableCell className="text-center">
                      {polish.colorHex && (
                        <Link
                          href={`/polishes/search?color=${polish.colorHex.replace("#", "")}`}
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
        pageSize={PAGE_SIZE}
        onPageChange={setPage}
      />
    </div>
  );
}
