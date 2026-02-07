"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import type { Polish, PolishFinish } from "swatchwatch-shared";
import { FINISHES } from "@/lib/constants";
import { listPolishes } from "@/lib/api";
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

type SortField = "name" | "brand" | "createdAt" | "rating";
type SortOrder = "asc" | "desc";

export default function PolishesPage() {
  const [polishes, setPolishes] = useState<Polish[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [brandFilter, setBrandFilter] = useState<string>("all");
  const [finishFilter, setFinishFilter] = useState<string>("all");
  const [sortField, setSortField] = useState<SortField>("name");
  const [sortOrder, setSortOrder] = useState<SortOrder>("asc");

  // Derive unique brands from loaded data
  const brands = [...new Set(polishes.map((p) => p.brand).filter(Boolean))].sort();

  useEffect(() => {
    async function fetchPolishes() {
      try {
        setLoading(true);
        const response = await listPolishes();
        setPolishes(response.polishes);
      } catch (err: any) {
        setError(err.message || "Failed to load polishes");
      } finally {
        setLoading(false);
      }
    }
    fetchPolishes();
  }, []);

  const filtered = polishes.filter((p) => {
    const matchesSearch =
      !search ||
      p.name.toLowerCase().includes(search.toLowerCase()) ||
      p.brand.toLowerCase().includes(search.toLowerCase()) ||
      (p.color && p.color.toLowerCase().includes(search.toLowerCase()));
    const matchesBrand = brandFilter === "all" || p.brand === brandFilter;
    const matchesFinish = finishFilter === "all" || p.finish === finishFilter;
    return matchesSearch && matchesBrand && matchesFinish;
  });

  const sorted = [...filtered].sort((a, b) => {
    const dir = sortOrder === "asc" ? 1 : -1;
    if (sortField === "rating") {
      return ((a.rating ?? 0) - (b.rating ?? 0)) * dir;
    }
    if (sortField === "createdAt") {
      return (a.createdAt.localeCompare(b.createdAt)) * dir;
    }
    const aVal = a[sortField].toLowerCase();
    const bVal = b[sortField].toLowerCase();
    return aVal.localeCompare(bVal) * dir;
  });

  function toggleSort(field: SortField) {
    if (sortField === field) {
      setSortOrder(sortOrder === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortOrder("asc");
    }
  }

  function SortIndicator({ field }: { field: SortField }) {
    if (sortField !== field) return <span className="text-muted-foreground/40 ml-1">↕</span>;
    return <span className="ml-1">{sortOrder === "asc" ? "↑" : "↓"}</span>;
  }

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
          <h1 className="text-2xl font-bold tracking-tight">Collection</h1>
          <p className="text-muted-foreground">
            {polishes.length} polishes · {filtered.length} shown
          </p>
        </div>
        <Button asChild>
          <Link href="/polishes/new">+ Add Polish</Link>
        </Button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <Input
          placeholder="Search by name, brand, or color…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-xs"
        />
        <Select value={brandFilter} onValueChange={setBrandFilter}>
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="All Brands" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Brands</SelectItem>
            {brands.map((brand) => (
              <SelectItem key={brand} value={brand}>
                {brand}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={finishFilter} onValueChange={setFinishFilter}>
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="All Finishes" />
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
        {(search || brandFilter !== "all" || finishFilter !== "all") && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSearch("");
              setBrandFilter("all");
              setFinishFilter("all");
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
              <TableHead className="w-10" />
              <TableHead>
                <button onClick={() => toggleSort("brand")} className="flex items-center font-medium">
                  Brand <SortIndicator field="brand" />
                </button>
              </TableHead>
              <TableHead>
                <button onClick={() => toggleSort("name")} className="flex items-center font-medium">
                  Name <SortIndicator field="name" />
                </button>
              </TableHead>
              <TableHead>Color</TableHead>
              <TableHead>Finish</TableHead>
              <TableHead>
                <button onClick={() => toggleSort("rating")} className="flex items-center font-medium">
                  Rating <SortIndicator field="rating" />
                </button>
              </TableHead>
              <TableHead>Tags</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                  No polishes match your filters.
                </TableCell>
              </TableRow>
            ) : (
              sorted.map((polish) => (
                <TableRow key={polish.id} className="cursor-pointer hover:bg-muted/50">
                  <TableCell>
                    <ColorDot hex={polish.colorHex} size="sm" />
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
                  <TableCell>{polish.color}</TableCell>
                  <TableCell>
                    {polish.finish && (
                      <Badge variant="secondary">
                        {polish.finish}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {polish.rating ? "★".repeat(polish.rating) + "☆".repeat(5 - polish.rating) : "—"}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {polish.tags?.map((tag) => (
                        <Badge key={tag} variant="outline" className="text-xs">
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
