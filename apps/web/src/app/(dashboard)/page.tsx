"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import type { Polish } from "swatchwatch-shared";
import { listPolishes } from "@/lib/api";
import { undertoneBreakdown } from "@/lib/color-utils";
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
      } catch (err: any) {
        setError(err.message || "Failed to load dashboard data");
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
    </div>
  );
}
