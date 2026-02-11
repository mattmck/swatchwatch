"use client";

import { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Polish } from "swatchwatch-shared";
import { getPolish, deletePolish, listPolishes } from "@/lib/api";
import { colorDistance, hexToOklch, oklchToHex } from "@/lib/color-utils";
import { finishBadgeClassName, finishLabel } from "@/lib/constants";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ColorDot } from "@/components/color-dot";
import { BrandSpinner } from "@/components/brand-spinner";
import { ErrorState } from "@/components/error-state";
import { toast } from "sonner";

export default function PolishDetailClient({ id }: { id: string }) {
  const router = useRouter();
  const [polish, setPolish] = useState<Polish | null>(null);
  const [allPolishes, setAllPolishes] = useState<Polish[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function fetchPolish() {
      try {
        setLoading(true);
        const data = await getPolish(id);
        if (cancelled) return;
        setPolish(data);
      } catch (err: unknown) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load polish");
      } finally {
        if (cancelled) return;
        setLoading(false);
      }
    }

    if (id) {
      fetchPolish();
      listPolishes()
        .then((response) => {
          if (cancelled) return;
          setAllPolishes(response.polishes);
        })
        .catch(() => {
          // Keep detail view usable even if related-color enrichment fails.
        });
    }

    return () => {
      cancelled = true;
    };
  }, [id]);

  const colorProfile = useMemo(() => {
    const hex = polish?.colorHex;
    if (!hex) return null;

    const oklch = hexToOklch(hex);
    const hue = Number.isNaN(oklch.h) ? 0 : oklch.h;
    const lightnessPct = Math.round(oklch.L * 100);
    const chromaPct = Math.round(Math.min(oklch.C / 0.37, 1) * 100);
    const huePct = Math.round((hue / 360) * 100);
    const neutralHex = oklchToHex({ ...oklch, C: 0 });
    const vividHex = oklchToHex({ ...oklch, C: Math.max(oklch.C, 0.24) });

    return {
      oklch,
      hue,
      lightnessPct,
      chromaPct,
      huePct,
      neutralHex,
      vividHex,
    };
  }, [polish?.colorHex]);

  const relatedShades = useMemo(() => {
    const currentHex = polish?.colorHex;
    const currentId = polish?.id;
    if (!currentHex || !currentId) return [];

    return allPolishes
      .filter(
        (candidate): candidate is Polish & { colorHex: string } =>
          candidate.id !== currentId &&
          typeof candidate.colorHex === "string" &&
          /^#[0-9A-Fa-f]{6}$/.test(candidate.colorHex)
      )
      .map((candidate) => ({
        polish: candidate,
        distance: colorDistance(currentHex, candidate.colorHex),
      }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 5);
  }, [allPolishes, polish]);

  async function handleDelete() {
    if (!polish || !confirm("Delete this polish from your collection?")) return;
    try {
      setDeleting(true);
      await deletePolish(polish.id);
      toast.success("Polish deleted", {
        description: `${polish.brand} ${polish.name} was removed from your collection.`,
      });
      router.push("/polishes");
    } catch (err: unknown) {
      toast.error("Delete failed", {
        description: err instanceof Error ? err.message : "Failed to delete polish.",
      });
      setDeleting(false);
    }
  }

  if (!id) {
    return <ErrorState message="Missing polish ID." onRetry={() => router.push("/polishes")} />;
  }

  if (loading) return <BrandSpinner label="Loading polish…" />;

  if (error || !polish) {
    return (
      <ErrorState
        message={error || "Polish not found"}
        onRetry={() => router.push("/polishes")}
      />
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <nav className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link href="/polishes" className="hover:text-foreground">
          Collection
        </Link>
        <span>/</span>
        <span className="text-foreground">
          {polish.brand} — {polish.name}
        </span>
      </nav>

      <div
        className="relative overflow-hidden rounded-2xl p-6 sm:p-8"
        style={{
          background: polish.colorHex
            ? `linear-gradient(135deg, ${polish.colorHex}33 0%, ${polish.colorHex}11 100%)`
            : undefined,
        }}
      >
        <div
          aria-hidden
          className="pointer-events-none absolute -right-10 -top-10 size-40 rounded-full opacity-30 blur-3xl"
          style={{ background: polish.colorHex || "transparent" }}
        />
        <div className="relative flex items-start justify-between">
          <div className="flex items-center gap-4">
            <div
              className="size-16 shrink-0 rounded-xl shadow-lg ring-2 ring-white/50"
              style={{ backgroundColor: polish.colorHex || "#ccc" }}
            />
            <div>
              <h1 className="heading-page">{polish.name}</h1>
              <p className="text-muted-foreground">{polish.brand}</p>
              {polish.colorHex && (
                <p className="mt-1 font-mono text-xs text-muted-foreground">{polish.colorHex}</p>
              )}
            </div>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => router.push(`/polishes/new?id=${polish.id}`)}
            >
              Edit
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          </div>
        </div>
      </div>

      <Card className="relative overflow-hidden">
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 w-1 bg-gradient-to-b from-brand-pink-soft via-brand-lilac to-brand-purple"
        />
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-muted-foreground">Color</p>
              <p className="font-medium flex items-center gap-2">
                <ColorDot
                  hex={polish.colorHex}
                  size="md"
                  className="ring-2 ring-white/80 shadow-[0_0_0_1px_rgba(66,16,126,0.18),0_8px_20px_rgba(66,16,126,0.16)]"
                />
                {polish.color}
                {polish.colorHex && (
                  <span className="font-mono text-xs text-muted-foreground">
                    {polish.colorHex}
                  </span>
                )}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground">Finish</p>
              <p className="font-medium">
                {polish.finish ? (
                  <Badge className={finishBadgeClassName(polish.finish)}>
                    {finishLabel(polish.finish)}
                  </Badge>
                ) : (
                  "—"
                )}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground">Collection</p>
              <p className="font-medium">{polish.collection ?? "—"}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Size</p>
              <p className="font-medium">{polish.size ?? "—"}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Quantity</p>
              <p className="font-medium">{polish.quantity ?? 1}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Rating</p>
              <p className="font-medium text-base">
                {polish.rating
                  ? "★".repeat(polish.rating) + "☆".repeat(5 - polish.rating)
                  : "Not rated"}
              </p>
            </div>
          </div>

          {polish.tags && polish.tags.length > 0 && (
            <>
              <Separator />
              <div>
                <p className="text-sm text-muted-foreground mb-2">Tags</p>
                <div className="flex flex-wrap gap-1.5">
                  {polish.tags.map((tag) => (
                    <Badge key={tag} variant="outline">
                      {tag}
                    </Badge>
                  ))}
                </div>
              </div>
            </>
          )}

          {polish.notes && (
            <>
              <Separator />
              <div>
                <p className="text-sm text-muted-foreground mb-1">Notes</p>
                <p className="text-sm">{polish.notes}</p>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {colorProfile && (
        <Card className="relative overflow-hidden">
          <span
            aria-hidden
            className="absolute inset-y-0 left-0 w-1 bg-gradient-to-b from-brand-lilac via-brand-pink-soft to-brand-purple"
          />
          <CardHeader>
            <CardTitle>Color Profile</CardTitle>
            <CardDescription>
              Perceptual OKLCH breakdown for this shade.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-lg border bg-muted/30 px-3 py-2">
                <p className="text-xs text-muted-foreground">Lightness (L)</p>
                <p className="font-semibold">{colorProfile.oklch.L.toFixed(3)}</p>
              </div>
              <div className="rounded-lg border bg-muted/30 px-3 py-2">
                <p className="text-xs text-muted-foreground">Chroma (C)</p>
                <p className="font-semibold">{colorProfile.oklch.C.toFixed(3)}</p>
              </div>
              <div className="rounded-lg border bg-muted/30 px-3 py-2">
                <p className="text-xs text-muted-foreground">Hue (h)</p>
                <p className="font-semibold">{Math.round(colorProfile.hue)}°</p>
              </div>
            </div>

            <ColorMetricBar
              label="Lightness"
              value={`${colorProfile.lightnessPct}%`}
              markerPct={colorProfile.lightnessPct}
              gradient="linear-gradient(to right, #0B0B10 0%, #F8F8FC 100%)"
            />
            <ColorMetricBar
              label="Chroma"
              value={`${colorProfile.chromaPct}%`}
              markerPct={colorProfile.chromaPct}
              gradient={`linear-gradient(to right, ${colorProfile.neutralHex} 0%, ${colorProfile.vividHex} 100%)`}
            />
            <ColorMetricBar
              label="Hue"
              value={`${Math.round(colorProfile.hue)}°`}
              markerPct={colorProfile.huePct}
              gradient="linear-gradient(to right, #ff3b30 0%, #ff9500 16%, #ffd60a 32%, #34c759 48%, #0a84ff 64%, #5e5ce6 80%, #ff2d55 100%)"
            />
          </CardContent>
        </Card>
      )}

      {relatedShades.length > 0 && (
        <Card className="relative overflow-hidden">
          <span
            aria-hidden
            className="absolute inset-y-0 left-0 w-1 bg-gradient-to-b from-brand-purple via-brand-lilac to-brand-pink-soft"
          />
          <CardHeader>
            <CardTitle>Related Shades</CardTitle>
            <CardDescription>
              Closest matches in your inventory by perceptual color distance.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {relatedShades.map(({ polish: related, distance }) => (
                <Link
                  key={related.id}
                  href={`/polishes/detail?id=${related.id}`}
                  className="flex items-center gap-3 rounded-lg border px-3 py-2 transition-colors hover:bg-brand-pink-light/15"
                >
                  <ColorDot
                    hex={related.colorHex}
                    size="md"
                    className="ring-2 ring-white/80 shadow-[0_0_0_1px_rgba(66,16,126,0.18),0_8px_18px_rgba(66,16,126,0.14)]"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{related.name}</p>
                    <p className="truncate text-sm text-muted-foreground">
                      {related.brand}
                      {related.finish ? ` · ${finishLabel(related.finish)}` : ""}
                    </p>
                  </div>
                  <Badge variant="outline" className="shrink-0">
                    {toSimilarityPercent(distance)}% match
                  </Badge>
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function toSimilarityPercent(distance: number): number {
  const maxDistance = 0.5;
  const normalized = 1 - distance / maxDistance;
  return Math.max(0, Math.min(100, Math.round(normalized * 100)));
}

function ColorMetricBar({
  label,
  value,
  markerPct,
  gradient,
}: {
  label: string;
  value: string;
  markerPct: number;
  gradient: string;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{label}</span>
        <span className="font-mono">{value}</span>
      </div>
      <div className="relative h-3 overflow-hidden rounded-full border border-border/70 bg-muted/40">
        <div className="absolute inset-0" style={{ background: gradient }} />
        <span
          aria-hidden
          className="absolute top-1/2 h-4 w-4 -translate-y-1/2 rounded-full border-2 border-white bg-brand-purple shadow-sm"
          style={{ left: `calc(${Math.max(0, Math.min(100, markerPct))}% - 8px)` }}
        />
      </div>
    </div>
  );
}
