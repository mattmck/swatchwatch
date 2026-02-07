"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { PolishFinish } from "polish-inventory-shared";
import { FINISHES } from "@/lib/mock-data";
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

export default function NewPolishPage() {
  const router = useRouter();
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

  function update(field: string, value: string | number) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // TODO: POST to /api/polishes
    alert("Polish saved! (mock — API not connected yet)");
    router.push("/polishes");
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Add Polish</h1>
        <p className="text-muted-foreground">
          Add a new polish to your collection.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Polish Details</CardTitle>
          <CardDescription>
            Fill in the details below, or use voice input to describe your polish.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Brand + Name row */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label htmlFor="brand" className="text-sm font-medium">
                  Brand <span className="text-destructive">*</span>
                </label>
                <Input
                  id="brand"
                  placeholder="e.g. OPI, Essie, ILNP"
                  value={form.brand}
                  onChange={(e) => update("brand", e.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <label htmlFor="name" className="text-sm font-medium">
                  Name <span className="text-destructive">*</span>
                </label>
                <Input
                  id="name"
                  placeholder="e.g. Big Apple Red"
                  value={form.name}
                  onChange={(e) => update("name", e.target.value)}
                  required
                />
              </div>
            </div>

            {/* Color + Hex row */}
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
              </div>
            </div>

            {/* Finish + Collection row */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Finish</label>
                <Select
                  value={form.finish}
                  onValueChange={(val) => update("finish", val)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select finish type" />
                  </SelectTrigger>
                  <SelectContent>
                    {FINISHES.map((f) => (
                      <SelectItem key={f} value={f}>
                        {f.charAt(0).toUpperCase() + f.slice(1)}
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

            {/* Quantity + Size row */}
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
                  onChange={(e) => update("quantity", parseInt(e.target.value) || 1)}
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
                <div className="flex gap-1 pt-1">
                  {[1, 2, 3, 4, 5].map((star) => (
                    <button
                      key={star}
                      type="button"
                      onClick={() => update("rating", form.rating === star ? 0 : star)}
                      className="text-xl transition-colors hover:text-primary"
                    >
                      {star <= form.rating ? "★" : "☆"}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Notes */}
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
                className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>

            {/* Tags */}
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

            {/* Voice input placeholder */}
            <div className="rounded-lg border-2 border-dashed border-muted-foreground/25 p-4 text-center">
              <p className="text-sm text-muted-foreground">
                🎙️ Voice input coming soon — describe your polish and we'll fill in the details
              </p>
            </div>

            {/* Actions */}
            <div className="flex gap-3 pt-2">
              <Button type="submit">Save Polish</Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => router.push("/polishes")}
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
