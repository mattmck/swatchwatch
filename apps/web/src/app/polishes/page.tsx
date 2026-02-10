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
import { UndertoneBadge } from "@/components/undertone-badge";
import { undertone } from "@/lib/color-utils";

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

  const toggleSimilar = () => {
    const next = !similarMode;
    setSimilarMode(next);
    if (next) setComplementaryMode(false);
  };

  const toggleComplementary = () => {
    const next = !complementaryMode;
    setComplementaryMode(next);
    if (next) setSimilarMode(false);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <p className="text-muted-foreground">Loading polishes...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center space-y-2">
          <p className="text-destructive font-medium">Error loading polishes</p>
          <p className="text-sm text-muted-foreground">{error}</p>
          <Button onClick={() => window.location.reload()}>Retry</Button>
        </div>
      </div>
    );
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


        <label className="flex items-center gap-1.5 text-sm cursor-pointer select-none">
          <input
            type="checkbox"
            checked={favorCollection}
            onChange={(e) => setFavorCollection(e.target.checked)}
            className="accent-primary"
          />
          Favor My Collection
        </label>

        <label className="flex items-center gap-1.5 text-sm cursor-pointer select-none">
          <input
            type="checkbox"
            checked={includeAll}
            onChange={(e) => setIncludeAll(e.target.checked)}
            className="accent-primary"
          />
          Include All
        </label>

        <label className="flex items-center gap-1.5 text-sm cursor-pointer select-none">
          <input
            type="checkbox"
            checked={similarMode}
            onChange={toggleSimilar}
            className="accent-primary"
          />
          Similar
          {similarMode && referenceColor && (
            <ColorDot hex={referenceColor} size="sm" />
          )}
        </label>

        <label className="flex items-center gap-1.5 text-sm cursor-pointer select-none">
          <input
            type="checkbox"
            checked={complementaryMode}
            onChange={toggleComplementary}
            className="accent-primary"
          />
          Complementary
          {complementaryMode && referenceColor && (
            <ColorDot hex={complementaryHex(referenceColor)} size="sm" />
          )}
        </label>

        {(search || !includeAll || similarMode || complementaryMode) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSearch("");
              setIncludeAll(true);
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
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">Status</TableHead>
              <TableHead>Brand</TableHead>
              <TableHead>Name</TableHead>
              <TableHead className="w-12">Color</TableHead>
              <TableHead>Tone</TableHead>
              <TableHead className="w-12">Find</TableHead>
              <TableHead>Finish</TableHead>
              <TableHead>Collection</TableHead>
              <TableHead className="w-28 text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pageItems.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
                  No polishes match your filters.
                </TableCell>
              </TableRow>
            ) : (
              pageItems.map((polish) => {
                const owned = isOwned(polish);
                return (
                  <TableRow key={polish.id} className="hover:bg-muted/50">
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
                    <TableCell>
                      {polish.colorHex && (
                        <UndertoneBadge undertone={undertone(polish.colorHex)} />
                      )}
                    </TableCell>
                    <TableCell>
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
                        <Badge variant="secondary">
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
