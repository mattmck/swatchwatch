"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Polish } from "swatchwatch-shared";
import { getPolish, deletePolish } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ColorDot } from "@/components/color-dot";
import { BrandSpinner } from "@/components/brand-spinner";
import { ErrorState } from "@/components/error-state";

export default function PolishDetailClient({ id }: { id: string }) {
  const router = useRouter();
  const [polish, setPolish] = useState<Polish | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    async function fetchPolish() {
      try {
        setLoading(true);
        const data = await getPolish(id);
        setPolish(data);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Failed to load polish");
      } finally {
        setLoading(false);
      }
    }

    if (id) fetchPolish();
  }, [id]);

  async function handleDelete() {
    if (!polish || !confirm("Delete this polish from your collection?")) return;
    try {
      setDeleting(true);
      await deletePolish(polish.id);
      router.push("/polishes");
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Failed to delete");
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
                <ColorDot hex={polish.colorHex} size="sm" />
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
                  <Badge className="border border-brand-pink-soft/60 bg-brand-pink-soft/30 text-brand-ink">{polish.finish}</Badge>
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
    </div>
  );
}
