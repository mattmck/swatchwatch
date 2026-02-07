"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
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

export default function PolishDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [polish, setPolish] = useState<Polish | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    async function fetchPolish() {
      try {
        setLoading(true);
        const data = await getPolish(params.id);
        setPolish(data);
      } catch (err: any) {
        setError(err.message || "Failed to load polish");
      } finally {
        setLoading(false);
      }
    }
    if (params.id) fetchPolish();
  }, [params.id]);

  async function handleDelete() {
    if (!polish || !confirm("Delete this polish from your collection?")) return;
    try {
      setDeleting(true);
      await deletePolish(polish.id);
      router.push("/polishes");
    } catch (err: any) {
      alert(err.message || "Failed to delete");
      setDeleting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <p className="text-muted-foreground">Loading polish...</p>
      </div>
    );
  }

  if (error || !polish) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center space-y-2">
          <p className="text-destructive font-medium">
            {error || "Polish not found"}
          </p>
          <Button variant="outline" onClick={() => router.push("/polishes")}>
            Back to Collection
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link href="/polishes" className="hover:text-foreground">
          Collection
        </Link>
        <span>/</span>
        <span className="text-foreground">{polish.brand} — {polish.name}</span>
      </nav>

      <div className="flex items-start justify-between">
        <div className="flex items-center gap-4">
          <ColorDot hex={polish.colorHex} size="lg" />
          <div>
            <h1 className="text-2xl font-bold tracking-tight">{polish.name}</h1>
            <p className="text-muted-foreground">{polish.brand}</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm">
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

      <Card>
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
                  <Badge variant="secondary">{polish.finish}</Badge>
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

          <Separator />
          <div className="grid grid-cols-2 gap-4 text-xs text-muted-foreground">
            <div>
              Added: {new Date(polish.createdAt).toLocaleDateString()}
            </div>
            <div>
              Updated: {new Date(polish.updatedAt).toLocaleDateString()}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Swatch / photo placeholder */}
      <Card>
        <CardHeader>
          <CardTitle>Photos</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4">
            <div className="flex aspect-square items-center justify-center rounded-lg border-2 border-dashed border-muted-foreground/25 text-sm text-muted-foreground">
              📸 Swatch photo
            </div>
            <div className="flex aspect-square items-center justify-center rounded-lg border-2 border-dashed border-muted-foreground/25 text-sm text-muted-foreground">
              💅 Nail photo
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
