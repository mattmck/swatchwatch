"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { CaptureQuestion, CaptureStatus, PolishFinish } from "swatchwatch-shared";
import {
  addCaptureFrameFromFile,
  answerCaptureQuestion,
  finalizeCapture,
  getCaptureStatus,
  startCapture,
} from "@/lib/api";
import { FINISHES } from "@/lib/constants";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type FrameType = "barcode" | "label" | "color" | "other";

export default function RapidAddPage() {
  const router = useRouter();

  const [brandHint, setBrandHint] = useState("");
  const [shadeHint, setShadeHint] = useState("");
  const [finishHint, setFinishHint] = useState<PolishFinish | "">("");
  const [collectionHint, setCollectionHint] = useState("");

  const [captureId, setCaptureId] = useState<string | null>(null);
  const [captureStatus, setCaptureStatus] = useState<CaptureStatus | null>(null);
  const [captureQuestion, setCaptureQuestion] = useState<CaptureQuestion | null>(null);
  const [captureMetadata, setCaptureMetadata] = useState<Record<string, unknown> | null>(null);
  const [captureFrameType, setCaptureFrameType] = useState<FrameType>("label");
  const [captureFrameFile, setCaptureFrameFile] = useState<File | null>(null);
  const [captureBusy, setCaptureBusy] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [captureAnswerInput, setCaptureAnswerInput] = useState("");

  const matchedInventoryId = captureMetadata?.inventoryItemId;

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

  function buildCaptureMetadata(source: string): Record<string, unknown> {
    return {
      source,
      brand: brandHint || undefined,
      shadeName: shadeHint || undefined,
      finish: finishHint || undefined,
      collection: collectionHint || undefined,
    };
  }

  async function refreshCaptureStatus(sessionId: string) {
    const status = await getCaptureStatus(sessionId);
    setCaptureStatus(status.status);
    setCaptureQuestion(status.question || null);
    setCaptureMetadata(status.metadata || null);
  }

  async function handleStartCapture() {
    await runCaptureAction(async () => {
      const started = await startCapture({ metadata: buildCaptureMetadata("web-rapid-add") });
      setCaptureId(started.captureId);
      setCaptureStatus(started.status);
      setCaptureQuestion(null);
      setCaptureMetadata(null);
    });
  }

  async function handleTextOnlyMatch() {
    await runCaptureAction(async () => {
      const started = await startCapture({ metadata: buildCaptureMetadata("web-rapid-add-text-only") });
      setCaptureId(started.captureId);
      setCaptureMetadata(null);

      const finalized = await finalizeCapture(started.captureId);
      setCaptureStatus(finalized.status);
      setCaptureQuestion(finalized.question || null);
      await refreshCaptureStatus(started.captureId);
    });
  }

  async function handleAddCaptureFrame() {
    if (!captureId) return;
    if (!captureFrameFile) {
      setCaptureError("Choose an image file before adding a frame.");
      return;
    }

    await runCaptureAction(async () => {
      const res = await addCaptureFrameFromFile(captureId, {
        frameType: captureFrameType,
        file: captureFrameFile,
        quality: {
          source: "web-file-input",
          fileName: captureFrameFile.name,
          mimeType: captureFrameFile.type,
          fileSize: captureFrameFile.size,
          lastModified: captureFrameFile.lastModified,
        },
      });
      setCaptureStatus(res.status);
    });
  }

  async function handleFinalizeCapture() {
    if (!captureId) return;
    await runCaptureAction(async () => {
      const finalized = await finalizeCapture(captureId);
      setCaptureStatus(finalized.status);
      setCaptureQuestion(finalized.question || null);
      if (finalized.status === "matched" || finalized.status === "unmatched") {
        await refreshCaptureStatus(captureId);
      }
    });
  }

  async function handleRefreshCaptureStatus() {
    if (!captureId) return;
    await runCaptureAction(async () => {
      await refreshCaptureStatus(captureId);
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
      if (res.status === "matched" || res.status === "unmatched") {
        await refreshCaptureStatus(captureId);
      }
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
      if (res.status === "matched" || res.status === "unmatched") {
        await refreshCaptureStatus(captureId);
      }
    });
  }

  useEffect(() => {
    if (!captureId || captureStatus !== "processing") {
      return;
    }

    let cancelled = false;
    const intervalId = window.setInterval(async () => {
      try {
        const status = await getCaptureStatus(captureId);
        if (cancelled) return;
        setCaptureStatus(status.status);
        setCaptureQuestion(status.question || null);
        setCaptureMetadata(status.metadata || null);
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

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Rapid Add</h1>
          <p className="text-muted-foreground">
            Capture-driven flow for fast matching and inventory updates.
          </p>
        </div>
        <Button asChild variant="outline">
          <Link href="/polishes/new">Manual Add</Link>
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Match Hints</CardTitle>
          <CardDescription>
            Optional brand/shade hints improve text-only matching before OCR pipeline lands.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Input
              value={brandHint}
              onChange={(e) => setBrandHint(e.target.value)}
              placeholder="Brand (e.g. OPI)"
            />
            <Input
              value={shadeHint}
              onChange={(e) => setShadeHint(e.target.value)}
              placeholder="Shade (e.g. Big Apple Red)"
            />
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Select
              value={finishHint}
              onValueChange={(value) => setFinishHint(value as PolishFinish)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Optional finish hint" />
              </SelectTrigger>
              <SelectContent>
                {FINISHES.map((finish) => (
                  <SelectItem key={finish} value={finish}>
                    {finish}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              value={collectionHint}
              onChange={(e) => setCollectionHint(e.target.value)}
              placeholder="Collection (optional)"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={handleStartCapture} disabled={captureBusy}>
              Start Session
            </Button>
            <Button type="button" variant="outline" onClick={handleTextOnlyMatch} disabled={captureBusy}>
              Match From Form Fields
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
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Add Frame</CardTitle>
          <CardDescription>
            Select an image from camera/gallery and submit it as a capture frame.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-[140px_1fr_auto]">
            <Select
              value={captureFrameType}
              onValueChange={(value) => setCaptureFrameType(value as FrameType)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="barcode">barcode</SelectItem>
                <SelectItem value="label">label</SelectItem>
                <SelectItem value="color">color</SelectItem>
                <SelectItem value="other">other</SelectItem>
              </SelectContent>
            </Select>
            <input
              type="file"
              accept="image/*"
              capture="environment"
              onChange={(e) => setCaptureFrameFile(e.target.files?.[0] || null)}
              className="h-9 rounded-md border border-input bg-background px-3 py-1 text-sm"
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
          <p className="text-xs text-muted-foreground">
            Selected file: {captureFrameFile ? captureFrameFile.name : "none"} (image files only, max 5MB)
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Session State</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="text-xs text-muted-foreground">
            <p>Capture ID: {captureId || "not started"}</p>
            <p>Status: {captureStatus || "n/a"}</p>
            {captureStatus === "processing" && <p>Polling status every 3s…</p>}
            {captureQuestion && <p>Open question: {captureQuestion.prompt}</p>}
            {captureStatus === "matched" && typeof matchedInventoryId !== "undefined" && (
              <p>Inventory item created: {String(matchedInventoryId)}</p>
            )}
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
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleAnswerSkip}
                  disabled={captureBusy}
                >
                  Skip
                </Button>
              </div>
            </div>
          )}

          {captureError && (
            <p className="text-xs text-destructive">{captureError}</p>
          )}

          {captureStatus === "matched" && typeof matchedInventoryId !== "undefined" && (
            <Button
              type="button"
              onClick={() => router.push(`/polishes/detail?id=${String(matchedInventoryId)}`)}
            >
              View Added Polish
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
