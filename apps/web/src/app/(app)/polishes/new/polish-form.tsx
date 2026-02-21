"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { PolishFinish } from "swatchwatch-shared";
import { resolveDisplayHex } from "swatchwatch-shared";
import { FINISHES } from "@/lib/constants";
import { createPolish, getPolish, updatePolish } from "@/lib/api";
import { useReferenceData } from "@/hooks/use-reference-data";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { BrandSpinner } from "@/components/brand-spinner";

const PRESET_SWATCHES = [
  "#F8D3E2",
  "#F7A8C1",
  "#F46A8D",
  "#E14F65",
  "#FFAF6D",
  "#F7D878",
  "#F1F1A3",
  "#B7E4A8",
  "#6BD4B0",
  "#4EC9E2",
  "#6A8FF6",
  "#9C7BFF",
  "#C899FF",
  "#F6B8FF",
];

const RATING_STARS = [1, 2, 3, 4, 5] as const;

function resolveReturnTo(returnTo: string | null): string {
  if (!returnTo) return "/polishes";
  try {
    const decoded = decodeURIComponent(returnTo);
    if (decoded.startsWith("/") && !decoded.startsWith("//")) {
      return decoded;
    }
  } catch {
    // Ignore malformed values and use fallback.
  }
  return "/polishes";
}

export default function PolishForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const editId = searchParams.get("id");
  const returnTo = searchParams.get("returnTo");
  const listHref = resolveReturnTo(returnTo);
  const isEditing = Boolean(editId);
  const [form, setForm] = useState({
    brand: "",
    name: "",
    color: "",
    colorHex: "#000000",
    finish: "" as PolishFinish | "",
    collection: "",
    quantity: 1,
    size: "",
    rating: 0,
    notes: "",
    tags: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [loadingExisting, setLoadingExisting] = useState(false);
  const { finishTypes } = useReferenceData();
  const finishOptions = useMemo(
    () =>
      (
        finishTypes.length > 0
          ? finishTypes.map((finish) => ({ value: finish.name, label: finish.displayName }))
          : FINISHES.map((finish) => ({
            value: finish,
            label: finish.charAt(0).toUpperCase() + finish.slice(1),
          }))
      ).sort((a, b) => a.label.localeCompare(b.label)),
    [finishTypes]
  );

  function update(field: string, value: string | number) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  useEffect(() => {
    if (!editId) return;
    setLoadingExisting(true);
    getPolish(editId)
      .then((data) => {
        setForm({
          brand: data.brand ?? "",
          name: data.name ?? "",
          color: data.color ?? "",
          colorHex: resolveDisplayHex(data) ?? "#000000",
          finish: (data.finish as PolishFinish | "") ?? "",
          collection: data.collection ?? "",
          quantity: data.quantity ?? 1,
          size: data.size ?? "",
          rating: data.rating ?? 0,
          notes: data.notes ?? "",
          tags: data.tags?.join(", ") ?? "",
        });
      })
      .catch((err: unknown) => {
        setSubmitError(err instanceof Error ? err.message : "Failed to load polish details");
      })
      .finally(() => setLoadingExisting(false));
  }, [editId]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setSubmitError(null);
    const payload = {
      brand: form.brand,
      name: form.name,
      color: form.color,
      vendorHex: form.colorHex,
      finish: (form.finish || undefined) as PolishFinish | undefined,
      collection: form.collection || undefined,
      quantity: form.quantity,
      size: form.size || undefined,
      rating: form.rating || undefined,
      notes: form.notes || undefined,
      tags: form.tags
        ? form.tags.split(",").map((t) => t.trim()).filter(Boolean)
        : undefined,
    };
    try {
      if (isEditing && editId) {
        const updated = await updatePolish(editId, payload);
        router.push(
          `/polishes/detail?id=${updated.id}&returnTo=${encodeURIComponent(listHref)}`
        );
      } else {
        const created = await createPolish(payload);
        if (created?.id) {
          router.push(
            `/polishes/detail?id=${created.id}&returnTo=${encodeURIComponent(listHref)}`
          );
        } else {
          router.push(listHref);
        }
      }
    } catch (err: unknown) {
      setSubmitError(err instanceof Error ? err.message : "Failed to save polish");
    } finally {
      setSubmitting(false);
    }
  }

  if (loadingExisting) {
    return <BrandSpinner label="Loading polish…" />;
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="heading-page">
          {isEditing ? "Edit Polish" : "Add Polish"}
        </h1>
        <p className="text-muted-foreground">
          {isEditing ? "Update the details for this polish." : "Add a new polish to your collection."}
        </p>
      </div>

      <div className="flex items-center justify-between rounded-lg border border-muted bg-muted/30 p-4">
        <div>
          <p className="text-sm font-medium">Need faster onboarding?</p>
          <p className="text-xs text-muted-foreground">
            Use Rapid Add for capture-driven matching and one-tap inventory adds.
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href="/rapid-add">Open Rapid Add</Link>
        </Button>
      </div>

      <Card className="relative overflow-hidden">
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 w-1 bg-gradient-to-b from-brand-pink-soft via-brand-lilac to-brand-purple"
        />
        <CardHeader>
          <CardTitle>Polish Details</CardTitle>
          <CardDescription>
            {isEditing ? "Modify any fields and save your changes." : "Fill in the details below to add an item manually."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label htmlFor="brand" className="text-sm font-medium">
                  Brand <span className="text-destructive">*</span>
                </label>
                <Input id="brand" value={form.brand} onChange={(e) => update("brand", e.target.value)} required />
              </div>
              <div className="space-y-2">
                <label htmlFor="name" className="text-sm font-medium">
                  Name <span className="text-destructive">*</span>
                </label>
                <Input id="name" value={form.name} onChange={(e) => update("name", e.target.value)} required />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label htmlFor="color" className="text-sm font-medium">
                  Color <span className="text-destructive">*</span>
                </label>
                <Input
                  id="color"
                  placeholder="e.g. Red, Teal, Lavender"
                  value={form.color}
                  onChange={(e) => update("color", e.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <label htmlFor="colorHex" className="text-sm font-medium">
                  Color Hex
                </label>
                <div className="flex gap-2">
                  <input
                    type="color"
                    id="colorHex"
                    value={form.colorHex}
                    onChange={(e) => update("colorHex", e.target.value)}
                    className="h-9 w-12 cursor-pointer rounded-md border border-input p-0.5"
                  />
                  <Input
                    value={form.colorHex}
                    onChange={(e) => update("colorHex", e.target.value)}
                    className="flex-1 font-mono"
                  />
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.25em] text-brand-purple/70">
                    Quick swatches
                  </p>
                  <div className="mt-3 grid grid-cols-7 gap-2 sm:grid-cols-10">
                    {PRESET_SWATCHES.map((hex) => {
                      const isSelected = form.colorHex.toLowerCase() === hex.toLowerCase();
                      return (
                        <button
                          key={hex}
                          type="button"
                          onClick={() => update("colorHex", hex)}
                          className={`relative flex h-9 w-9 items-center justify-center rounded-xl border transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                            isSelected
                              ? "border-brand-purple shadow-glow-brand"
                              : "border-transparent hover:border-brand-lilac/60"
                          }`}
                          aria-label={`Use swatch ${hex}`}
                          aria-pressed={isSelected}
                          style={{ backgroundColor: hex }}
                        >
                          <span className="sr-only">{hex}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Finish</label>
                <Select value={form.finish} onValueChange={(val) => update("finish", val)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select finish type" />
                  </SelectTrigger>
                  <SelectContent>
                    {finishOptions.map((finish) => (
                      <SelectItem key={finish.value} value={finish.value}>
                        {finish.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <label htmlFor="collection" className="text-sm font-medium">
                  Collection
                </label>
                <Input
                  id="collection"
                  placeholder="e.g. Spring 2026"
                  value={form.collection}
                  onChange={(e) => update("collection", e.target.value)}
                />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-2">
                <label htmlFor="quantity" className="text-sm font-medium">
                  Quantity
                </label>
                <Input
                  id="quantity"
                  type="number"
                  min={1}
                  value={form.quantity}
                  onChange={(e) => update("quantity", parseInt(e.target.value, 10) || 1)}
                />
              </div>
              <div className="space-y-2">
                <label htmlFor="size" className="text-sm font-medium">
                  Size
                </label>
                <Input
                  id="size"
                  placeholder="e.g. 15ml"
                  value={form.size}
                  onChange={(e) => update("size", e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Rating</label>
                <div className="relative flex items-center gap-3 overflow-hidden rounded-xl border border-brand-lilac/40 bg-card px-3 py-2 shadow-sm">
                  <span
                    aria-hidden
                    className="pointer-events-none absolute inset-0 opacity-30 [background:linear-gradient(120deg,rgba(248,211,226,0.6),rgba(156,123,255,0.35))]"
                  />
                  <div className="relative flex gap-1">
                    {RATING_STARS.map((star) => {
                      const isActive = star <= form.rating;
                      return (
                        <button
                          key={star}
                          type="button"
                          onClick={() => update("rating", form.rating === star ? 0 : star)}
                          className={`relative z-10 rounded-full p-1 transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                            isActive
                              ? "scale-105 drop-shadow-[0_6px_20px_rgba(158,91,255,0.35)]"
                              : "opacity-70 hover:opacity-100"
                          }`}
                          aria-label={`Rate ${star} star${star > 1 ? "s" : ""}`}
                          aria-pressed={isActive}
                        >
                          <GradientStar active={isActive} gradientId={`rating-star-${star}`} />
                        </button>
                      );
                    })}
                  </div>
                  <span className="relative z-10 text-sm text-muted-foreground">
                    {form.rating ? `${form.rating} / 5` : "Tap a star to rate"}
                  </span>
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <label htmlFor="notes" className="text-sm font-medium">
                Notes
              </label>
              <textarea
                id="notes"
                rows={3}
                placeholder="Formula notes, number of coats, etc."
                value={form.notes}
                onChange={(e) => update("notes", e.target.value)}
                className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="tags" className="text-sm font-medium">
                Tags
              </label>
              <Input
                id="tags"
                placeholder="Comma-separated: favorite, indie, spring"
                value={form.tags}
                onChange={(e) => update("tags", e.target.value)}
              />
            </div>

            {submitError && <p className="text-sm text-destructive">{submitError}</p>}
            <div className="flex gap-3 pt-2">
              <Button
                type="submit"
                disabled={submitting}
                className="bg-gradient-brand text-white shadow-glow-brand hover:opacity-90 disabled:opacity-60"
              >
                {submitting ? "Saving…" : isEditing ? "Save Changes" : "Save Polish"}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  if (isEditing && editId) {
                    router.push(
                      `/polishes/detail?id=${editId}&returnTo=${encodeURIComponent(listHref)}`
                    );
                  } else {
                    router.push(listHref);
                  }
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

function GradientStar({ active, gradientId }: { active: boolean; gradientId: string }) {
  return (
    <svg viewBox="0 0 24 24" role="presentation" className="size-6 drop-shadow-sm" aria-hidden>
      <defs>
        <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="oklch(0.852 0.107 341.3)" />
          <stop offset="100%" stopColor="oklch(0.546 0.275 290.7)" />
        </linearGradient>
      </defs>
      <polygon
        points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"
        fill={active ? `url(#${gradientId})` : "transparent"}
        stroke={active ? "oklch(0.546 0.275 290.7)" : "oklch(0.785 0.128 299.5)"}
        strokeWidth={active ? 1.2 : 1}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
