"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import type { HueFamily, LightnessBand, Polish } from "swatchwatch-shared";
import { listPolishes } from "@/lib/api";
import {
  LIGHTNESS_BAND_ORDER,
  HUE_FAMILY_ORDER,
  analyzeCollectionGaps,
  undertoneBreakdown,
} from "@/lib/color-utils";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ColorDot } from "@/components/color-dot";
import { UndertoneBreakdown } from "@/components/undertone-breakdown";

const HUE_FAMILY_LABELS: Record<HueFamily, string> = {
  reds: "Reds",
  "oranges-corals": "Oranges / Corals",
  "yellows-golds": "Yellows / Golds",
  greens: "Greens",
  "blues-teals": "Blues / Teals",
  "purples-violets": "Purples / Violets",
  "pinks-magentas": "Pinks / Magentas",
  neutrals: "Neutrals",
};

const LIGHTNESS_BAND_LABELS: Record<LightnessBand, string> = {
  dark: "Dark",
  medium: "Medium",
  light: "Light",
};

export default function DashboardPage() {
  const [polishes, setPolishes] = useState<Polish[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchData() {
      try {
        setLoading(true);
        const response = await listPolishes();
        setPolishes(response.polishes);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Failed to load dashboard data");
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <p className="text-muted-foreground">Loading dashboard...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center space-y-2">
          <p className="text-destructive font-medium">Error loading dashboard</p>
          <p className="text-sm text-muted-foreground">{error}</p>
          <Button onClick={() => window.location.reload()}>Retry</Button>
        </div>
      </div>
    );
  }

  const totalPolishes = polishes.length;
  const uniqueBrands = new Set(polishes.map((p) => p.brand)).size;
  const avgRating =
    polishes.reduce((sum, p) => sum + (p.rating ?? 0), 0) / totalPolishes;
  const finishCounts: Record<string, number> = {};
  for (const p of polishes) {
    if (p.finish) finishCounts[p.finish] = (finishCounts[p.finish] || 0) + 1;
  }
  const topFinishes = Object.entries(finishCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4);

  const toneBreakdown = undertoneBreakdown(
    polishes.filter((p) => p.colorHex).map((p) => p.colorHex!)
  );
  const ownedColorHexes = polishes
    .filter((p) => (p.quantity ?? 0) > 0 && p.colorHex)
    .map((p) => p.colorHex!);
  const gapAnalysis = analyzeCollectionGaps(ownedColorHexes);
  const gapCounts = new Map(
    gapAnalysis.cells.map((cell) => [`${cell.hueFamily}:${cell.lightnessBand}`, cell.count]),
  );
  const missingKeys = new Set(
    gapAnalysis.missing.map((cell) => `${cell.hueFamily}:${cell.lightnessBand}`),
  );
  const underrepresentedKeys = new Set(
    gapAnalysis.underrepresented.map((cell) => `${cell.hueFamily}:${cell.lightnessBand}`),
  );

  const recentPolishes = [...polishes]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 5);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-muted-foreground">
            Your SwatchWatch collection at a glance.
          </p>
        </div>
        <Button asChild>
          <Link href="/polishes/new">+ Add Polish</Link>
        </Button>
      </div>

      {/* Stats row */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total Polishes</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold">{totalPolishes}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Brands</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold">{uniqueBrands}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Avg Rating</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold">{avgRating.toFixed(1)} ★</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Top Finish</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold capitalize">
              {topFinishes[0]?.[0] ?? "—"}
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Recent additions */}
        <Card>
          <CardHeader>
            <CardTitle>Recent Additions</CardTitle>
            <CardDescription>Last 5 polishes added</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {recentPolishes.map((polish) => (
                <Link
                  key={polish.id}
                  href={`/polishes/${polish.id}`}
                  className="flex items-center gap-3 rounded-md p-2 transition-colors hover:bg-muted"
                >
                  <ColorDot hex={polish.colorHex} size="md" />
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate">{polish.name}</p>
                    <p className="text-sm text-muted-foreground">{polish.brand}</p>
                  </div>
                  {polish.finish && (
                    <Badge variant="secondary" className="shrink-0">
                      {polish.finish}
                    </Badge>
                  )}
                </Link>
              ))}
            </div>
            <div className="mt-4 text-center">
              <Button variant="outline" size="sm" asChild>
                <Link href="/polishes">View All →</Link>
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Collection breakdown: finish + undertone */}
        <Card>
          <CardHeader>
            <CardTitle>Collection Breakdown</CardTitle>
            <CardDescription>Finish types and color undertone analysis</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Finish bars */}
            <div>
              <p className="text-sm font-medium mb-3">By Finish</p>
              <div className="space-y-2.5">
                {topFinishes.map(([finish, count]) => (
                  <div key={finish} className="flex items-center gap-3">
                    <span className="w-24 text-sm capitalize">{finish}</span>
                    <div className="flex-1 h-3 rounded-full bg-muted overflow-hidden">
                      <div
                        className="h-full rounded-full bg-primary"
                        style={{ width: `${(count / totalPolishes) * 100}%` }}
                      />
                    </div>
                    <span className="text-sm text-muted-foreground w-8 text-right">
                      {count}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Undertone breakdown */}
            <div>
              <p className="text-sm font-medium mb-3">
                Palette Undertone
                <span className="font-normal text-muted-foreground">
                  {" "}— leans{" "}
                  <span className="capitalize font-medium text-foreground">{toneBreakdown.dominant}</span>
                </span>
              </p>
              <UndertoneBreakdown
                warm={toneBreakdown.warm}
                cool={toneBreakdown.cool}
                neutral={toneBreakdown.neutral}
                total={polishes.filter((p) => p.colorHex).length}
              />
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Collection Gaps</CardTitle>
          <CardDescription>
            Owned-polish coverage by hue and lightness (OKLCH). Missing and sparse cells suggest what to add next.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {ownedColorHexes.length} owned polishes with color data • {gapAnalysis.missing.length} missing cells •{" "}
            {gapAnalysis.underrepresented.length} underrepresented cells
          </p>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse text-sm">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="pb-2 pr-2 font-medium">Hue</th>
                  {LIGHTNESS_BAND_ORDER.map((band) => (
                    <th key={band} className="pb-2 px-2 font-medium">
                      {LIGHTNESS_BAND_LABELS[band]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {HUE_FAMILY_ORDER.map((hueFamily) => (
                  <tr key={hueFamily} className="border-t">
                    <td className="py-2 pr-2 text-xs font-medium">{HUE_FAMILY_LABELS[hueFamily]}</td>
                    {LIGHTNESS_BAND_ORDER.map((band) => {
                      const key = `${hueFamily}:${band}`;
                      const count = gapCounts.get(key) ?? 0;
                      const isMissing = missingKeys.has(key);
                      const isUnderrepresented = underrepresentedKeys.has(key);
                      const toneClass = isMissing
                        ? "bg-destructive/10 text-destructive"
                        : isUnderrepresented
                          ? "bg-amber-100 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
                          : "bg-emerald-100 text-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200";
                      return (
                        <td key={band} className="py-2 px-2">
                          <div className={`rounded px-2 py-1 text-center text-xs font-medium ${toneClass}`}>
                            {count}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <p className="mb-2 text-sm font-medium">Most Missing</p>
              <div className="space-y-1 text-xs text-muted-foreground">
                {gapAnalysis.missing.slice(0, 6).map((cell) => (
                  <p key={`${cell.hueFamily}:${cell.lightnessBand}`}>
                    {HUE_FAMILY_LABELS[cell.hueFamily]} • {LIGHTNESS_BAND_LABELS[cell.lightnessBand]}
                  </p>
                ))}
                {gapAnalysis.missing.length === 0 && <p>None</p>}
              </div>
            </div>
            <div>
              <p className="mb-2 text-sm font-medium">Underrepresented</p>
              <div className="space-y-1 text-xs text-muted-foreground">
                {gapAnalysis.underrepresented.slice(0, 6).map((cell) => (
                  <p key={`${cell.hueFamily}:${cell.lightnessBand}`}>
                    {HUE_FAMILY_LABELS[cell.hueFamily]} • {LIGHTNESS_BAND_LABELS[cell.lightnessBand]}
                  </p>
                ))}
                {gapAnalysis.underrepresented.length === 0 && <p>None</p>}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
