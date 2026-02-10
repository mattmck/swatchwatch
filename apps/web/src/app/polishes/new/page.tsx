"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { CaptureQuestion, CaptureStatus, PolishFinish } from "swatchwatch-shared";
import { FINISHES } from "@/lib/constants";
import {
  addCaptureFrame,
  answerCaptureQuestion,
  createPolish,
  finalizeCapture,
  getCaptureStatus,
  startCapture,
} from "@/lib/api";
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

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [captureId, setCaptureId] = useState<string | null>(null);
  const [captureStatus, setCaptureStatus] = useState<CaptureStatus | null>(null);
  const [captureQuestion, setCaptureQuestion] = useState<CaptureQuestion | null>(null);
  const [captureFrameUrl, setCaptureFrameUrl] = useState("");
  const [captureFrameType, setCaptureFrameType] = useState<"barcode" | "label" | "color" | "other">("label");
  const [captureBusy, setCaptureBusy] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [captureAnswerInput, setCaptureAnswerInput] = useState("");

  function update(field: string, value: string | number) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function runCaptureAction(action: () => Promise<void>) {
    setCaptureBusy(true);
    setCaptureError(null);
    try {
      await action();
    } catch (err: unknown) {
      setCaptureError(err instanceof Error ? err.message : "Capture request failed");
    } finally {
      setCaptureBusy(false);
    }
  }

  async function handleStartCapture() {
    await runCaptureAction(async () => {
      const res = await startCapture({
        metadata: {
          source: "web-polishes-new",
          brand: form.brand || undefined,
          shadeName: form.name || undefined,
          finish: form.finish || undefined,
          collection: form.collection || undefined,
        },
      });
      setCaptureId(res.captureId);
      setCaptureStatus(res.status);
      setCaptureQuestion(null);
    });
  }

  async function handleAddCaptureFrame() {
    if (!captureId) return;
    await runCaptureAction(async () => {
      const res = await addCaptureFrame(captureId, {
        frameType: captureFrameType,
        imageBlobUrl: captureFrameUrl || "https://example.com/mock-frame.jpg",
      });
      setCaptureStatus(res.status);
    });
  }

  async function handleFinalizeCapture() {
    if (!captureId) return;
    await runCaptureAction(async () => {
      const res = await finalizeCapture(captureId);
      setCaptureStatus(res.status);
      setCaptureQuestion(res.question || null);
    });
  }

  async function handleRefreshCaptureStatus() {
    if (!captureId) return;
    await runCaptureAction(async () => {
      const res = await getCaptureStatus(captureId);
      setCaptureStatus(res.status);
      setCaptureQuestion(res.question || null);
    });
  }

  async function handleAnswerSkip() {
    if (!captureId || !captureQuestion) return;
    await runCaptureAction(async () => {
      const res = await answerCaptureQuestion(captureId, {
        questionId: captureQuestion.id,
        answer: "skip",
      });
      setCaptureStatus(res.status);
      setCaptureQuestion(res.question || null);
    });
  }

  async function handleAnswerSubmit() {
    if (!captureId || !captureQuestion || !captureAnswerInput.trim()) return;
    await runCaptureAction(async () => {
      const res = await answerCaptureQuestion(captureId, {
        questionId: captureQuestion.id,
        answer: captureAnswerInput.trim(),
      });
      setCaptureStatus(res.status);
      setCaptureQuestion(res.question || null);
      setCaptureAnswerInput("");
    });
  }

  useEffect(() => {
    if (!captureId || captureStatus !== "processing") {
      return;
    }

    let cancelled = false;

    const intervalId = window.setInterval(async () => {
      try {
        const res = await getCaptureStatus(captureId);
        if (cancelled) return;
        setCaptureStatus(res.status);
        setCaptureQuestion(res.question || null);
      } catch (err: unknown) {
        if (cancelled) return;
        setCaptureError(err instanceof Error ? err.message : "Failed to refresh capture status");
      }
    }, 3000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [captureId, captureStatus]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setSubmitError(null);
    try {
      await createPolish({
        brand: form.brand,
        name: form.name,
        color: form.color,
        colorHex: form.colorHex,
        finish: (form.finish || undefined) as PolishFinish | undefined,
        collection: form.collection || undefined,
        quantity: form.quantity,
        size: form.size || undefined,
        rating: form.rating || undefined,
        notes: form.notes || undefined,
        tags: form.tags
          ? form.tags.split(",").map((t) => t.trim()).filter(Boolean)
          : undefined,
      });
      router.push("/polishes");
    } catch (err: unknown) {
      setSubmitError(err instanceof Error ? err.message : "Failed to save polish");
    } finally {
      setSubmitting(false);
    }
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

            {/* Rapid Add scaffold */}
            <div className="space-y-3 rounded-lg border border-muted p-4">
              <p className="text-sm font-medium">Rapid Add (Capture Scaffold)</p>
              <p className="text-xs text-muted-foreground">
                Temporary UI to exercise /api/capture endpoints while the camera workflow is in progress.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" onClick={handleStartCapture} disabled={captureBusy}>
                  Start Session
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleRefreshCaptureStatus}
                  disabled={captureBusy || !captureId}
                >
                  Refresh Status
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleFinalizeCapture}
                  disabled={captureBusy || !captureId}
                >
                  Finalize
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleAnswerSkip}
                  disabled={captureBusy || !captureId || !captureQuestion}
                >
                  Answer "Skip"
                </Button>
              </div>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-[120px_1fr_auto]">
                <select
                  value={captureFrameType}
                  onChange={(e) => setCaptureFrameType(e.target.value as "barcode" | "label" | "color" | "other")}
                  className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                >
                  <option value="barcode">barcode</option>
                  <option value="label">label</option>
                  <option value="color">color</option>
                  <option value="other">other</option>
                </select>
                <Input
                  value={captureFrameUrl}
                  onChange={(e) => setCaptureFrameUrl(e.target.value)}
                  placeholder="Optional frame URL (uses mock URL if empty)"
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleAddCaptureFrame}
                  disabled={captureBusy || !captureId}
                >
                  Add Frame
                </Button>
              </div>
              <div className="text-xs text-muted-foreground">
                <p>Capture ID: {captureId || "not started"}</p>
                <p>Status: {captureStatus || "n/a"}</p>
                {captureStatus === "processing" && <p>Polling status every 3s…</p>}
                {captureQuestion && <p>Open question: {captureQuestion.prompt}</p>}
              </div>
              {captureQuestion && (
                <div className="space-y-2 rounded-md border border-border/50 p-3">
                  <p className="text-xs font-medium text-foreground">Question Answer</p>
                  {captureQuestion.options?.length ? (
                    <p className="text-xs text-muted-foreground">
                      Options: {captureQuestion.options.join(" | ")}
                    </p>
                  ) : null}
                  <div className="flex gap-2">
                    <Input
                      value={captureAnswerInput}
                      onChange={(e) => setCaptureAnswerInput(e.target.value)}
                      placeholder="Enter answer (e.g. 21 or brand + shade)"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleAnswerSubmit}
                      disabled={captureBusy || !captureAnswerInput.trim()}
                    >
                      Submit
                    </Button>
                  </div>
                </div>
              )}
              {captureError && (
                <p className="text-xs text-destructive">{captureError}</p>
              )}
            </div>

            {/* Actions */}
            {submitError && (
              <p className="text-sm text-destructive">{submitError}</p>
            )}
            <div className="flex gap-3 pt-2">
              <Button type="submit" disabled={submitting}>
                {submitting ? "Saving…" : "Save Polish"}
              </Button>
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
