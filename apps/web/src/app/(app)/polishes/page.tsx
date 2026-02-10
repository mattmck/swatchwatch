"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import Link from "next/link";
import type { Polish } from "swatchwatch-shared";
import { listPolishes, updatePolish } from "@/lib/api";
import { colorDistance, complementaryHex } from "@/lib/color-utils";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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

const PAGE_SIZE = 10;

export default function PolishesPage() {
  const [polishes, setPolishes] = useState<Polish[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [search, setSearch] = useState("");
  const [favorCollection, setFavorCollection] = useState(true);
  const [includeAll, setIncludeAll] = useState(true);
  const [similarMode, setSimilarMode] = useState(false);
  const [complementaryMode, setComplementaryMode] = useState(false);
  const [referenceColor, setReferenceColor] = useState<string | null>(null);

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
  }, [search, favorCollection, includeAll, similarMode, complementaryMode, referenceColor]);

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
          (p.color && p.color.toLowerCase().includes(q))
      );
    }

    // Include All unchecked = owned only
    if (!includeAll) {
      result = result.filter(isOwned);
    }

    return result;
  }, [polishes, search, includeAll]);

  const sorted = useMemo(() => {
    const result = [...filtered];

    // Color-distance sort (Similar or Complementary)
    if ((similarMode || complementaryMode) && referenceColor) {
      const ref = complementaryMode ? complementaryHex(referenceColor) : referenceColor;
      result.sort((a, b) => {
        const distA = a.colorHex ? colorDistance(a.colorHex, ref) : Infinity;
        const distB = b.colorHex ? colorDistance(b.colorHex, ref) : Infinity;
        return distA - distB;
      });
    } else {
      // Default: alphabetical by name
      result.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    }

    // Favor My Collection: stable-sort owned to top
    if (favorCollection) {
      result.sort((a, b) => {
        const aOwned = isOwned(a) ? 0 : 1;
        const bOwned = isOwned(b) ? 0 : 1;
        return aOwned - bOwned;
      });
    }

    return result;
  }, [filtered, favorCollection, similarMode, complementaryMode, referenceColor]);

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

  const handleColorClick = (hex: string | undefined) => {
    if (!hex) return;
    setReferenceColor(hex);
    if (!similarMode && !complementaryMode) {
      setSimilarMode(true);
    }
  };

  const handleSimilarPressed = (next: boolean) => {
    setSimilarMode(next);
    if (next) setComplementaryMode(false);
  };

  const handleComplementaryPressed = (next: boolean) => {
    setComplementaryMode(next);
    if (next) setSimilarMode(false);
  };

  if (loading) return <BrandSpinner label="Loading polishes…" />;

  if (error) {
    return <ErrorState message={error} onRetry={() => window.location.reload()} />;
  }

  return (
    <div className="space-y-4">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">All Polishes</h1>
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

        <ToggleChip
          pressed={similarMode}
          onPressedChange={handleSimilarPressed}
          aria-label="Sort by similar shades"
        >
          <span className="flex items-center gap-2">
            Similar
            {similarMode && referenceColor && (
              <ColorDot hex={referenceColor} size="sm" />
            )}
          </span>
        </ToggleChip>

        <ToggleChip
          pressed={complementaryMode}
          onPressedChange={handleComplementaryPressed}
          aria-label="Sort by complementary shades"
        >
          <span className="flex items-center gap-2">
            Complementary
            {complementaryMode && referenceColor && (
              <ColorDot hex={complementaryHex(referenceColor)} size="sm" />
            )}
          </span>
        </ToggleChip>

        {(search || !includeAll || similarMode || complementaryMode) && (
          <Button
            variant="ghost"
            size="sm"
            className="text-brand-purple hover:bg-brand-pink-light/30"
            onClick={() => {
              setSearch("");
              setIncludeAll(true);
              setFavorCollection(true);
              setSimilarMode(false);
              setComplementaryMode(false);
              setReferenceColor(null);
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
              <TableHead className="w-12">Color</TableHead>
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
                        href={`/polishes/${polish.id}`}
                        className="text-primary hover:underline"
                      >
                        {polish.name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <button
                        type="button"
                        onClick={() => handleColorClick(polish.colorHex)}
                        className="cursor-pointer"
                        title="Click to set as reference color"
                      >
                        <ColorDot hex={polish.colorHex} size="sm" />
                      </button>
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
                        <Badge className="border border-brand-pink-soft/60 bg-brand-pink-soft/30 text-brand-ink">
                          {polish.finish.charAt(0).toUpperCase() + polish.finish.slice(1)}
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
