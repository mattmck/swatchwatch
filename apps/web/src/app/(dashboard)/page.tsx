import Link from "next/link";
import { MOCK_POLISHES } from "@/lib/mock-data";
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

export default function DashboardPage() {
  const polishes = MOCK_POLISHES;
  const totalPolishes = polishes.length;
  const uniqueBrands = new Set(polishes.map((p) => p.brand)).size;
  const avgRating =
    polishes.reduce((sum, p) => sum + (p.rating ?? 0), 0) / totalPolishes;
  const topFinishes = Object.entries(
    polishes.reduce(
      (acc, p) => {
        if (p.finish) acc[p.finish] = (acc[p.finish] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    )
  )
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4);

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

        {/* Finish breakdown */}
        <Card>
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
