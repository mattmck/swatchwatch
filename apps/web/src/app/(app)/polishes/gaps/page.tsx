"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { resolveDisplayHex, type Polish } from "swatchwatch-shared";
import { listAllPolishes } from "@/lib/api";
import {
  analyzeCollectionGaps,
  classifyHexToGapCell,
  HUE_FAMILY_ORDER,
  LIGHTNESS_BAND_ORDER,
} from "@/lib/color-utils";
import { BrandSpinner } from "@/components/brand-spinner";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CellMatchesList, type CellBoundPolish, Row } from "./gaps-components";
import {
  cellKey,
  getGapSearchHref,
  getSeverity,
  HUE_META,
  LIGHTNESS_META,
  SEVERITY_META,
  sortCellsByGridOrder,
} from "./gaps-utils";

export default function PolishCollectionGapsPage() {
  const [polishes, setPolishes] = useState<Polish[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedCellKey, setSelectedCellKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadPolishes() {
      try {
        setLoading(true);
        setError(null);
        const rows = await listAllPolishes({ sortBy: "createdAt", sortOrder: "desc" });
        if (!cancelled) setPolishes(rows);
      } catch (err: unknown) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load collection");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    loadPolishes();
    return () => {
      cancelled = true;
    };
  }, []);

  const ownedPolishes = useMemo(
    () => polishes.filter((polish) => (polish.quantity ?? 0) > 0),
    [polishes],
  );
  const cellBoundPolishes = useMemo<CellBoundPolish[]>(() => {
    const rows: CellBoundPolish[] = [];
    for (const polish of polishes) {
      const hex = resolveDisplayHex(polish);
      if (!hex) continue;
      const normalizedHex = hex.toUpperCase();
      const cell = classifyHexToGapCell(normalizedHex);
      if (!cell) continue;
      rows.push({
        polish,
        colorHex: normalizedHex,
        hueFamily: cell.hueFamily,
        lightnessBand: cell.lightnessBand,
        owned: (polish.quantity ?? 0) > 0,
      });
    }
    return rows.sort((a, b) => {
      const byBrand = a.polish.brand.localeCompare(b.polish.brand);
      if (byBrand !== 0) return byBrand;
      return a.polish.name.localeCompare(b.polish.name);
    });
  }, [polishes]);

  const ownedHexes = useMemo(() => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const polish of ownedPolishes) {
      const hex = resolveDisplayHex(polish);
      if (!hex) continue;
      const canonical = hex.toUpperCase();
      if (!/^#[0-9A-F]{6}$/.test(canonical)) continue;
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      result.push(canonical);
    }
    return result;
  }, [ownedPolishes]);

  const analysis = useMemo(() => analyzeCollectionGaps(ownedHexes), [ownedHexes]);
  const cellsByKey = useMemo(
    () => new Map(analysis.cells.map((cell) => [cellKey(cell), cell])),
    [analysis.cells],
  );

  const missingKeys = useMemo(
    () => new Set(analysis.missing.map((cell) => cellKey(cell))),
    [analysis.missing],
  );
  const thinKeys = useMemo(
    () => new Set(analysis.underrepresented.map((cell) => cellKey(cell))),
    [analysis.underrepresented],
  );

  const maxCellCount = useMemo(
    () => analysis.cells.reduce((max, cell) => Math.max(max, cell.count), 0),
    [analysis.cells],
  );

  const recommendedCells = useMemo(() => {
    const prioritized = [
      ...sortCellsByGridOrder(analysis.missing),
      ...analysis.underrepresented
        .filter((cell) => !missingKeys.has(cellKey(cell)))
        .sort((a, b) => a.count - b.count),
    ];
    return prioritized.slice(0, 6);
  }, [analysis.missing, analysis.underrepresented, missingKeys]);

  const selectedCell = selectedCellKey ? cellsByKey.get(selectedCellKey) ?? null : null;
  const selectedSeverity = selectedCell
    ? getSeverity(selectedCell, missingKeys, thinKeys)
    : null;
  const selectedSeverityMeta =
    selectedSeverity ? SEVERITY_META[selectedSeverity] : SEVERITY_META.healthy;
  const selectedCellBoundPolishes = useMemo(() => {
    if (!selectedCell) return [];
    return cellBoundPolishes.filter(
      (item) =>
        item.hueFamily === selectedCell.hueFamily &&
        item.lightnessBand === selectedCell.lightnessBand,
    );
  }, [selectedCell, cellBoundPolishes]);
  const selectedOwnedMatches = useMemo(
    () => selectedCellBoundPolishes.filter((item) => item.owned),
    [selectedCellBoundPolishes],
  );
  const selectedCatalogMatches = useMemo(
    () => selectedCellBoundPolishes.filter((item) => !item.owned),
    [selectedCellBoundPolishes],
  );

  useEffect(() => {
    if (selectedCellKey && cellsByKey.has(selectedCellKey)) return;
    const fallback =
      recommendedCells[0] ?? analysis.cells[0] ?? null;
    setSelectedCellKey(fallback ? cellKey(fallback) : null);
  }, [analysis.cells, recommendedCells, cellsByKey, selectedCellKey]);

  if (loading) return <BrandSpinner label="Analyzing collection gaps…" />;

  if (error) {
    return <ErrorState message={error} onRetry={() => window.location.reload()} />;
  }

  if (ownedPolishes.length === 0) {
    return (
      <EmptyState
        title="No collection yet"
        description="Add polishes to your collection to unlock the gap map and see what to buy next."
        actionLabel="+ Add Polish"
        actionHref="/polishes/new"
        className="min-h-[420px]"
      />
    );
  }

  if (ownedHexes.length === 0) {
    return (
      <EmptyState
        title="No colors available yet"
        description="We need at least one polish with a detectable display color to build a gap map."
        actionLabel="Open Polishes"
        actionHref="/polishes"
        className="min-h-[420px]"
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="heading-page">Collection Gap Map</h1>
          <p className="text-muted-foreground">
            See where your owned shades are dense, thin, or missing across hue and lightness.
          </p>
        </div>
        <Button asChild variant="outline">
          <Link href="/polishes/search">Open Color Search</Link>
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Card className="relative overflow-hidden border border-brand-purple/20">
          <span className="absolute inset-y-0 left-0 w-1 bg-gradient-to-b from-brand-pink-soft via-brand-lilac to-brand-purple" />
          <CardContent className="p-4">
            <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Owned Shades</p>
            <p className="mt-1 text-2xl font-black text-gradient-brand">{ownedHexes.length}</p>
            <p className="text-xs text-muted-foreground">Unique display colors in your collection</p>
          </CardContent>
        </Card>
        <Card className="relative overflow-hidden border border-rose-300/40">
          <span className="absolute inset-y-0 left-0 w-1 bg-rose-500/70" />
          <CardContent className="p-4">
            <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Missing Cells</p>
            <p className="mt-1 text-2xl font-black text-rose-600 dark:text-rose-300">{analysis.missing.length}</p>
            <p className="text-xs text-muted-foreground">No owned shades in that bucket</p>
          </CardContent>
        </Card>
        <Card className="relative overflow-hidden border border-amber-300/40">
          <span className="absolute inset-y-0 left-0 w-1 bg-amber-500/70" />
          <CardContent className="p-4">
            <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Thin Cells</p>
            <p className="mt-1 text-2xl font-black text-amber-600 dark:text-amber-300">{analysis.underrepresented.length}</p>
            <p className="text-xs text-muted-foreground">Represented, but below healthy coverage</p>
          </CardContent>
        </Card>
      </div>

      <Card className="relative overflow-hidden border border-brand-purple/20 bg-card/95">
        <span className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-brand-pink-soft via-brand-lilac to-brand-purple" />
        <CardHeader>
          <CardTitle>Hue × Lightness Heatmap</CardTitle>
          <CardDescription>
            Click any cell to inspect it. Missing and thin cells are prioritized for next-buy suggestions.
          </CardDescription>
        </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {(["missing", "thin", "healthy"] as const).map((severity) => (
                <Badge
                  key={severity}
                  variant="outline"
                  className={SEVERITY_META[severity].badgeClassName}
                >
                  {SEVERITY_META[severity].label}
                </Badge>
              ))}
            <span className="ml-auto">
              {analysis.cells.length} total cells ({HUE_FAMILY_ORDER.length} hue families × {LIGHTNESS_BAND_ORDER.length} lightness bands)
            </span>
          </div>

          <div className="overflow-x-auto pb-2">
            <div className="min-w-[920px]">
              <div className="grid grid-cols-[140px_repeat(8,minmax(88px,1fr))] gap-2">
                <div />
                {HUE_FAMILY_ORDER.map((hueFamily) => (
                  <div
                    key={hueFamily}
                    className="rounded-md border border-brand-lilac/45 bg-muted/40 px-2 py-2 text-center text-[11px] font-semibold leading-tight"
                  >
                    {HUE_META[hueFamily].label}
                  </div>
                ))}

                {LIGHTNESS_BAND_ORDER.map((lightnessBand) => (
                  <Row
                    key={lightnessBand}
                    lightnessBand={lightnessBand}
                    cellsByKey={cellsByKey}
                    maxCellCount={maxCellCount}
                    missingKeys={missingKeys}
                    thinKeys={thinKeys}
                    selectedCellKey={selectedCellKey}
                    onSelect={setSelectedCellKey}
                  />
                ))}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
        <Card className="border border-brand-lilac/35">
          <CardHeader>
            <CardTitle>Selected Cell</CardTitle>
            <CardDescription>
              {selectedCell
                ? `${HUE_META[selectedCell.hueFamily].label} • ${LIGHTNESS_META[selectedCell.lightnessBand].label}`
                : "Select a heatmap cell"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {selectedCell ? (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{HUE_META[selectedCell.hueFamily].label}</Badge>
                  <Badge variant="outline">{LIGHTNESS_META[selectedCell.lightnessBand].label}</Badge>
                  <Badge
                    variant="outline"
                    className={selectedSeverityMeta.badgeClassName}
                  >
                    {selectedSeverityMeta.label}
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground">
                  Owned shades in this exact cell:{" "}
                  <span className="font-semibold text-foreground">{selectedOwnedMatches.length}</span>
                </p>
                <p className="text-sm text-muted-foreground">
                  {selectedSeverityMeta.description}
                </p>
                <div className="grid gap-3 lg:grid-cols-2">
                  <CellMatchesList
                    title="In Your Collection"
                    items={selectedOwnedMatches}
                    emptyLabel="No owned shades in this cell yet."
                  />
                  <CellMatchesList
                    title="Available To Add"
                    items={selectedCatalogMatches}
                    emptyLabel="No additional catalog shades currently in this cell."
                  />
                </div>
                <Button asChild size="sm" variant="outline">
                  <Link href={getGapSearchHref(selectedCell)}>
                    Explore Seed Color in Search
                  </Link>
                </Button>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Select a cell in the heatmap.</p>
            )}
          </CardContent>
        </Card>

        <Card className="border border-brand-lilac/35">
          <CardHeader>
            <CardTitle>What To Add Next</CardTitle>
            <CardDescription>Priority cells sorted from emptiest to fullest.</CardDescription>
          </CardHeader>
          <CardContent>
            {recommendedCells.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Nice coverage. No missing or thin cells right now.
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {recommendedCells.map((cell) => {
                  const key = cellKey(cell);
                  const severity = getSeverity(cell, missingKeys, thinKeys);
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setSelectedCellKey(key)}
                      className={`rounded-full border px-3 py-1 text-xs transition ${
                        severity === "missing"
                          ? "border-rose-400/65 bg-rose-100/80 text-rose-800 hover:bg-rose-200/80 dark:bg-rose-950/40 dark:text-rose-100"
                          : "border-amber-400/65 bg-amber-100/80 text-amber-800 hover:bg-amber-200/80 dark:bg-amber-950/40 dark:text-amber-100"
                      }`}
                      title={`Count: ${cell.count}`}
                    >
                      {LIGHTNESS_META[cell.lightnessBand].label} {HUE_META[cell.hueFamily].label} ({cell.count})
                    </button>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
