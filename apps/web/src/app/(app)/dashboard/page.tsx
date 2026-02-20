"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import type { Polish } from "swatchwatch-shared";
import { resolveDisplayHex } from "swatchwatch-shared";
import { listAllPolishes } from "@/lib/api";
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
import { BrandSpinner } from "@/components/brand-spinner";
import { ErrorState } from "@/components/error-state";
import { EmptyState } from "@/components/empty-state";
import type { LucideIcon } from "lucide-react";
import { Building2, Droplets, Sparkles, Star } from "lucide-react";

type StatCard = {
  key: string;
  label: string;
  value: string;
  suffix?: string;
  subText: string;
  icon: LucideIcon;
  accent: string;
  valueClassName?: string;
};

export default function DashboardPage() {
  const [polishes, setPolishes] = useState<Polish[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchData() {
      try {
        setLoading(true);
        setError(null);
        const response = await listAllPolishes({
          sortBy: "createdAt",
          sortOrder: "desc",
        });
        setPolishes(response.filter((polish) => (polish.quantity ?? 0) > 0));
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Failed to load dashboard data");
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, []);

  if (loading) return <BrandSpinner label="Loading dashboard…" />;

  if (error) {
    return <ErrorState message={error} onRetry={() => window.location.reload()} />;
  }

  const totalPolishes = polishes.length;
  const uniqueBrands = new Set(polishes.map((p) => p.brand)).size;
  const avgRating =
    totalPolishes > 0
      ? polishes.reduce((sum, p) => sum + (p.rating ?? 0), 0) / totalPolishes
      : 0;
  const finishCounts = polishes.reduce((acc, polish) => {
    if (polish.finish) acc[polish.finish] = (acc[polish.finish] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  const topFinishes = Object.entries(finishCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4);
  const leadingFinish = topFinishes[0];

  const recentPolishes = [...polishes]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 5);

  const statCards: StatCard[] = [
    {
      key: "total",
      label: "Total Polishes",
      value: totalPolishes.toLocaleString(),
      subText: "Tracked shades in your collection",
      icon: Droplets,
      accent: "from-brand-pink-soft via-brand-lilac to-brand-purple",
    },
    {
      key: "brands",
      label: "Brands",
      value: uniqueBrands.toLocaleString(),
      subText: "Unique makers cataloged",
      icon: Building2,
      accent: "from-brand-purple via-brand-pink-soft to-brand-lilac",
    },
    {
      key: "rating",
      label: "Avg Rating",
      value: avgRating.toFixed(1),
      suffix: "★",
      subText:
        totalPolishes > 0
          ? "Across every rated polish"
          : "Add ratings to unlock insights",
      icon: Star,
      accent: "from-brand-lilac via-brand-pink to-brand-purple",
    },
    {
      key: "finish",
      label: "Top Finish",
      value: leadingFinish?.[0] ?? "—",
      valueClassName: "capitalize",
      subText: leadingFinish ? `${leadingFinish[1]} polishes logged` : "Log finishes to compare trends",
      icon: Sparkles,
      accent: "from-brand-purple via-brand-lilac to-brand-pink-soft",
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="heading-page">Dashboard</h1>
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
        {statCards.map((card) => (
          <Card
            key={card.key}
            className="relative overflow-hidden border border-brand-purple/20 bg-card/95 shadow-[0_20px_45px_rgba(66,16,126,0.12)] backdrop-blur-xl"
          >
            <span
              aria-hidden
              className={`absolute inset-y-0 left-0 w-1 bg-gradient-to-b ${card.accent}`}
            />
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 opacity-70 [background:radial-gradient(circle_at_top_right,rgba(249,227,255,0.65),transparent_55%)] dark:opacity-30"
            />
            <CardContent className="relative z-10 flex items-center justify-between gap-4 px-6 py-6">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.35em] text-brand-purple-deep/80 dark:text-brand-lilac/95">
                  {card.label}
                </p>
                <div className="mt-1 flex items-baseline gap-1">
                  <p
                    className={`text-3xl font-black leading-tight text-gradient-brand ${card.valueClassName ?? ""}`}
                  >
                    {card.value}
                  </p>
                  {card.suffix && (
                    <span className="text-lg font-semibold text-brand-purple dark:text-brand-pink-soft">
                      {card.suffix}
                    </span>
                  )}
                </div>
                <p className="mt-1 text-sm text-muted-foreground dark:text-brand-pink-soft/90">
                  {card.subText}
                </p>
              </div>
              <div className="flex size-12 items-center justify-center rounded-xl bg-gradient-brand-soft text-white shadow-glow-brand">
                <card.icon className="size-5" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Recent additions */}
        <Card className="relative overflow-hidden">
          <span
            aria-hidden
            className="absolute inset-y-0 left-0 w-1 bg-gradient-to-b from-brand-pink-soft via-brand-lilac to-brand-purple"
          />
          <CardHeader>
            <CardTitle>Recent Additions</CardTitle>
            <CardDescription>Last 5 polishes added</CardDescription>
          </CardHeader>
          <CardContent>
            {recentPolishes.length === 0 ? (
              <EmptyState
                title="No polishes yet"
                description="Start your collection with your first shade and track it here."
                actionLabel="+ Add Polish"
                actionHref="/polishes/new"
                className="min-h-[240px] py-4"
              />
            ) : (
              <>
                <div className="space-y-3">
                  {recentPolishes.map((polish) => (
                    <Link
                      key={polish.id}
                      href={`/polishes/detail?id=${polish.id}`}
                      className="flex items-center gap-3 rounded-md p-2 transition-colors hover:bg-muted"
                    >
                      <ColorDot hex={resolveDisplayHex(polish)} size="md" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">{polish.name}</p>
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
              </>
            )}
          </CardContent>
        </Card>

        {/* Finish breakdown */}
        <Card className="relative overflow-hidden">
          <span
            aria-hidden
            className="absolute inset-y-0 left-0 w-1 bg-gradient-to-b from-brand-purple via-brand-lilac to-brand-pink-soft"
          />
          <CardHeader>
            <CardTitle>By Finish</CardTitle>
            <CardDescription>Distribution of finish types</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
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
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
