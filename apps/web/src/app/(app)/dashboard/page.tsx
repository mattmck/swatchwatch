"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import type { Polish } from "swatchwatch-shared";
import { resolveDisplayHex, resolvePolishFinishes } from "swatchwatch-shared";
import { getCurrentUserId, listAllPolishes } from "@/lib/api";
import { wishlistValueView, type WishlistValueView } from "@/lib/wishlist-value";
import { isOwnedPolish, summarizeCollection } from "@/lib/inventory-status";
import { trackEvent } from "@/lib/telemetry";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FinishBadges } from "@/components/finish-badges";
import { useReferenceData } from "@/hooks/use-reference-data";
import { ColorDot } from "@/components/color-dot";
import { BrandSpinner } from "@/components/brand-spinner";
import { ErrorState } from "@/components/error-state";
import { EmptyState } from "@/components/empty-state";
import { PickForMeCard } from "@/components/pick-for-me";
import { GettingStarted } from "@/components/getting-started";
import { CollectionStatsSection } from "@/components/stats/collection-stats-section";
import type { LucideIcon } from "lucide-react";
import { Building2, Droplets, FlaskConical, Heart, Sparkles, Star } from "lucide-react";
import { detailHref } from "@/lib/detail-href";

type StatCard = {
  key: string;
  label: string;
  value: string;
  suffix?: string;
  subText: string;
  icon: LucideIcon;
  accent: string;
  valueClassName?: string;
  /** Optional link to the matching filtered table. */
  href?: string;
  /** Accessible name for the link (defaults to the label). */
  linkLabel?: string;
};

export default function DashboardPage() {
  const { finishTypes } = useReferenceData();
  const [polishes, setPolishes] = useState<Polish[]>([]);
  const [wishlistTotal, setWishlistTotal] = useState(0);
  // Brand list-price totals of every wishlist row (per currency, unpriced counted).
  const [wishlistValue, setWishlistValue] = useState<WishlistValueView | null>(null);
  // Keys the getting-started dismissal per user; null (lookup failed) falls back to one shared key.
  const [userId, setUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchData() {
      try {
        setLoading(true);
        setError(null);
        // Owned rows only: the dashboard never needs the shared catalog, and the
        // catalog is orders of magnitude larger than any user's collection.
        // Every wishlist row: its count and the brand list-price totals (the wishlist is far
        // smaller than the catalog).
        const [response, wishlistPage, currentUserId] = await Promise.all([
          listAllPolishes({
            status: ["owned"],
            sortBy: "createdAt",
            sortOrder: "desc",
          }),
          listAllPolishes({ status: ["wishlist"] }),
          getCurrentUserId().catch(() => null),
        ]);
        setUserId(currentUserId === null ? null : String(currentUserId));
        const owned = response.filter(isOwnedPolish);
        setPolishes(owned);
        setWishlistTotal(wishlistPage.length);
        setWishlistValue(wishlistValueView(wishlistPage));
        // Sprint 1 success metric: how much of the collection carries status/tried data.
        const summary = summarizeCollection(owned, wishlistPage.length);
        trackEvent("collection.summary", {
          owned: summary.owned,
          untried: summary.untried,
          untriedPercent: summary.untriedPercent,
          wishlist: summary.wishlist,
        });
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
  // A brand-new user gets the getting-started checklist instead of a wall of zeros and empty cards.
  const hasNothing = totalPolishes === 0 && wishlistTotal === 0;
  const summary = summarizeCollection(polishes, wishlistTotal);
  const uniqueBrands = new Set(polishes.map((p) => p.brand)).size;
  const avgRating =
    totalPolishes > 0
      ? polishes.reduce((sum, p) => sum + (p.rating ?? 0), 0) / totalPolishes
      : 0;
  // Multi-finish shades count once toward each of their finishes.
  const finishCounts = polishes.reduce((acc, polish) => {
    for (const finish of resolvePolishFinishes(polish)) {
      acc[finish] = (acc[finish] || 0) + 1;
    }
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
    {
      key: "wishlist",
      label: "Wishlist",
      value: summary.wishlist.toLocaleString(),
      subText:
        (summary.wishlist > 0 ? wishlistValue?.summary : null) ??
        (summary.wishlist === 1 ? "Shade you want next" : "Shades you want next"),
      icon: Heart,
      accent: "from-brand-pink via-brand-pink-soft to-brand-lilac",
      href: "/polishes?status=wishlist",
      linkLabel: `Wishlist: ${summary.wishlist.toLocaleString()} polishes. View wishlist`,
    },
    {
      key: "untried",
      label: "Untried",
      value: summary.untriedPercent === null ? "—" : String(summary.untriedPercent),
      suffix: summary.untriedPercent === null ? undefined : "%",
      subText:
        summary.untriedPercent === null
          ? "Own a polish to track what you've tried"
          : `${summary.untried.toLocaleString()} of ${summary.owned.toLocaleString()} owned never tried`,
      icon: FlaskConical,
      accent: "from-brand-lilac via-brand-purple to-brand-pink-soft",
      href: "/polishes?status=owned&untried=1",
      linkLabel:
        summary.untriedPercent === null
          ? "Untried polishes"
          : `Untried: ${summary.untriedPercent}% of owned (${summary.untried} polishes). View untried polishes`,
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
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

      <GettingStarted ownedPolishes={polishes} userId={userId} />

      {/* Stats row */}
      {!hasNothing && (
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3">
        {statCards.map((card) => {
          const tile = (
          <Card
            key={card.key}
            className={`relative h-full overflow-hidden border border-brand-purple/20 py-0 sm:py-6 bg-card/95 shadow-[0_20px_45px_rgba(66,16,126,0.12)] backdrop-blur-xl ${
              card.href ? "transition-shadow group-hover:shadow-[0_24px_50px_rgba(66,16,126,0.2)]" : ""
            }`}
          >
            <span
              aria-hidden
              className={`absolute inset-y-0 left-0 w-1 bg-gradient-to-b ${card.accent}`}
            />
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 opacity-70 [background:radial-gradient(circle_at_top_right,rgba(249,227,255,0.65),transparent_55%)] dark:opacity-30"
            />
            <CardContent className="relative z-10 flex h-full items-center justify-between gap-4 px-4 py-4 sm:px-6 sm:py-6">
              <div className="min-w-0">
                <p className="text-[10px] font-semibold uppercase tracking-[0.2em] sm:tracking-[0.35em] text-brand-purple-deep/80 dark:text-brand-lilac/95">
                  {card.label}
                </p>
                <div className="mt-1 flex items-baseline gap-1">
                  <p
                    className={`break-words text-2xl font-black leading-tight text-gradient-brand sm:text-3xl ${card.valueClassName ?? ""}`}
                  >
                    {card.value}
                  </p>
                  {card.suffix && (
                    <span className="text-lg font-semibold text-brand-purple dark:text-brand-pink-soft">
                      {card.suffix}
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs text-muted-foreground sm:text-sm dark:text-brand-pink-soft/90">
                  {card.subText}
                </p>
              </div>
              <div className="hidden size-12 shrink-0 items-center justify-center rounded-xl bg-gradient-brand-soft text-white shadow-glow-brand sm:flex">
                <card.icon className="size-5" aria-hidden="true" />
              </div>
            </CardContent>
          </Card>
          );
          return card.href ? (
            <Link
              key={card.key}
              href={card.href}
              aria-label={card.linkLabel ?? card.label}
              className="group block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              {tile}
            </Link>
          ) : (
            tile
          );
        })}
      </div>
      )}

      {totalPolishes > 0 && (
        <>
      <PickForMeCard polishes={polishes} />

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
                      href={detailHref(polish.id)}
                      className="flex items-center gap-3 rounded-md p-2 transition-colors hover:bg-muted"
                    >
                      <ColorDot hex={resolveDisplayHex(polish)} size="md" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">{polish.name}</p>
                        <p className="text-sm text-muted-foreground">{polish.brand}</p>
                      </div>
                      <FinishBadges polish={polish} finishTypes={finishTypes} max={2} className="shrink-0 justify-end" />
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
            {topFinishes.length === 0 && (
              <p className="text-sm text-muted-foreground">
                Finishes show up here once your polishes have one, like creme, shimmer or holo.
              </p>
            )}
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
        </>
      )}

      {/* Spend, wear and cost-per-wear panels (#271); loads its own data. */}
      <CollectionStatsSection />
    </div>
  );
}
