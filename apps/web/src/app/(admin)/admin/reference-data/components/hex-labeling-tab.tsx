"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  ImageOff,
  Pipette,
  Save,
  SkipForward,
  Undo2,
} from "lucide-react";
import { toast } from "sonner";
import {
  colorDistance,
  type HexLabelImage,
  type HexLabelQueueFilters,
  type HexLabelQueueItem,
  type HexLabelRequest,
  type HexLabelSampleMethod,
  type HexLabelSamplePoint,
  type HexLabelSaveResponse,
} from "swatchwatch-shared";
import { deleteHexLabel, getHexLabelQueue, saveHexLabel } from "@/lib/api";
import {
  HEX_LABEL_SAMPLE_SIZES,
  averageRegion,
  clientToPixel,
  hexLabelKeyAction,
  labelProgress,
  normalizeHexInput,
  planUndo,
  readableTextColor,
  stepSampleSize,
  toSamplePoint,
  type HexLabelKeyAction,
  type RegionSample,
} from "@/lib/hex-sampling";
import { buildSwatchThumbnailUrl } from "@/lib/image-url";
import { FinishBadges } from "@/components/finish-badges";
import { ToggleChip } from "@/components/toggle-chip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 20;
/** Prefetch the next page when this many shades are left in the loaded queue. */
const PREFETCH_REMAINING = 3;
/** Loupe: (2 * LOUPE_RADIUS + 1) image pixels shown at LOUPE_SIZE CSS pixels. */
const LOUPE_RADIUS = 7;
const LOUPE_SIZE = 150;

type FilterState = Required<Pick<HexLabelQueueFilters, "disagreeOnly" | "showLabeled" | "includeWithoutImages">> & {
  brand: string;
};

interface QueueState {
  key: string;
  items: HexLabelQueueItem[];
  nextCursor: string | null;
  total: number;
  labeled: number;
  threshold: number;
  index: number;
}

/** A pick awaiting save: where the colour came from. */
interface PickedColor {
  hex: string;
  method: HexLabelSampleMethod;
  imageId: string | null;
  samplePoint: HexLabelSamplePoint | null;
}

interface EyeDropperLike {
  open(): Promise<{ sRGBHex: string }>;
}

function getEyeDropperCtor(): (new () => EyeDropperLike) | null {
  if (typeof window === "undefined") return null;
  const ctor = (window as unknown as { EyeDropper?: new () => EyeDropperLike }).EyeDropper;
  return typeof ctor === "function" ? ctor : null;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function formatDistance(a: string | null | undefined, b: string | null | undefined): string | null {
  const ha = normalizeHexInput(a);
  const hb = normalizeHexInput(b);
  if (!ha || !hb) return null;
  return colorDistance(ha, hb).toFixed(3);
}

function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.tagName === "TEXTAREA" || target.tagName === "SELECT") return true;
  // Checkboxes, buttons and the like take no typing, so shortcuts stay active there.
  if (target instanceof HTMLInputElement) {
    return !["checkbox", "radio", "button", "submit", "reset", "range", "color"].includes(target.type);
  }
  return false;
}

// ── Swatch ──────────────────────────────────────────────────────────────────

function HexSwatch({ label, hex, detail, large }: { label: string; hex: string | null; detail?: string | null; large?: boolean }) {
  const normalized = normalizeHexInput(hex);
  return (
    <div className="min-w-0 space-y-1">
      <div
        className={cn(
          "flex items-end rounded-md border border-border p-1.5 font-mono text-[11px] font-medium",
          large ? "h-20" : "h-12",
          !normalized && "bg-muted text-muted-foreground"
        )}
        style={normalized ? { backgroundColor: normalized, color: readableTextColor(normalized) } : undefined}
        aria-label={`${label}: ${normalized ?? "none"}`}
      >
        {normalized ?? "—"}
      </div>
      <p className="truncate text-xs text-muted-foreground">
        {label}
        {detail ? <span className="ml-1 font-mono">{detail}</span> : null}
      </p>
    </div>
  );
}

// ── Image sampler (canvas eyedropper) ───────────────────────────────────────

type ImageStatus = "loading" | "ready" | "tainted" | "error";

interface SamplerPick {
  sample: RegionSample;
  samplePoint: HexLabelSamplePoint;
}

/**
 * Draws one product image into a canvas and samples an averaged `sampleSize`×`sampleSize` area
 * under the pointer. Images load with `crossOrigin="anonymous"` (the image proxy answers with
 * Access-Control-Allow-Origin for the web origin); if that fails, the image is shown without CORS
 * and sampling is disabled with an explanation (the native eyedropper still works).
 * Keyed by `src` by the parent, so each image starts in `loading`.
 */
function ImageSampler({
  src,
  alt,
  sampleSize,
  marker,
  onHover,
  onPick,
}: {
  src: string;
  alt: string;
  sampleSize: number;
  marker: HexLabelSamplePoint | null;
  onHover: (sample: RegionSample | null) => void;
  onPick: (pick: SamplerPick) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const loupeRef = useRef<HTMLCanvasElement | null>(null);
  const imageDataRef = useRef<ImageData | null>(null);
  const [status, setStatus] = useState<ImageStatus>("loading");
  const [pointer, setPointer] = useState<{ cssX: number; cssY: number; px: number; py: number; boxW: number; boxH: number } | null>(
    null
  );

  useEffect(() => {
    let cancelled = false;
    imageDataRef.current = null;
    const load = (withCors: boolean) => {
      const img = new Image();
      if (withCors) img.crossOrigin = "anonymous";
      img.decoding = "async";
      img.onload = () => {
        if (cancelled) return;
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext("2d", { willReadFrequently: true });
        if (!canvas || !ctx) return;
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        ctx.drawImage(img, 0, 0);
        try {
          imageDataRef.current = ctx.getImageData(0, 0, canvas.width, canvas.height);
          setStatus("ready");
        } catch {
          // SecurityError: the canvas is tainted (image served without CORS headers).
          imageDataRef.current = null;
          setStatus("tainted");
        }
      };
      img.onerror = () => {
        if (cancelled) return;
        if (withCors) load(false);
        else setStatus("error");
      };
      img.src = src;
    };
    load(true);
    return () => {
      cancelled = true;
    };
  }, [src]);

  // Redraw the magnifier around the pointer.
  useEffect(() => {
    const loupe = loupeRef.current;
    const canvas = canvasRef.current;
    if (!loupe || !canvas || !pointer) return;
    const ctx = loupe.getContext("2d");
    if (!ctx) return;
    const span = LOUPE_RADIUS * 2 + 1;
    const cell = LOUPE_SIZE / span;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, LOUPE_SIZE, LOUPE_SIZE);
    ctx.fillStyle = "#808080";
    ctx.fillRect(0, 0, LOUPE_SIZE, LOUPE_SIZE);
    ctx.drawImage(canvas, pointer.px - LOUPE_RADIUS, pointer.py - LOUPE_RADIUS, span, span, 0, 0, LOUPE_SIZE, LOUPE_SIZE);
    const half = Math.floor(sampleSize / 2);
    const start = (LOUPE_RADIUS - half) * cell;
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(0,0,0,0.85)";
    ctx.strokeRect(start, start, sampleSize * cell, sampleSize * cell);
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(255,255,255,0.95)";
    ctx.strokeRect(start + 2, start + 2, sampleSize * cell - 4, sampleSize * cell - 4);
  }, [pointer, sampleSize]);

  const locate = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const pixel = clientToPixel(event.clientX, event.clientY, rect, canvas.width, canvas.height);
      if (!pixel) return null;
      return {
        pixel,
        cssX: event.clientX - rect.left,
        cssY: event.clientY - rect.top,
        boxW: rect.width,
        boxH: rect.height,
      };
    },
    []
  );

  const sampleAt = useCallback(
    (pixel: { x: number; y: number }) => {
      const data = imageDataRef.current;
      if (!data) return null;
      return averageRegion(data.data, data.width, data.height, pixel.x, pixel.y, sampleSize);
    },
    [sampleSize]
  );

  function handleMove(event: React.PointerEvent<HTMLCanvasElement>) {
    if (status === "loading" || status === "error") return;
    const hit = locate(event);
    if (!hit) {
      setPointer(null);
      onHover(null);
      return;
    }
    setPointer({ cssX: hit.cssX, cssY: hit.cssY, px: hit.pixel.x, py: hit.pixel.y, boxW: hit.boxW, boxH: hit.boxH });
    onHover(sampleAt(hit.pixel));
  }

  function handleUp(event: React.PointerEvent<HTMLCanvasElement>) {
    if (status !== "ready" || event.button !== 0) return;
    const hit = locate(event);
    const canvas = canvasRef.current;
    if (!hit || !canvas) return;
    const sample = sampleAt(hit.pixel);
    if (!sample) {
      toast.error("Transparent area", { description: "No opaque pixels under the cursor; pick on the polish." });
      return;
    }
    onPick({ sample, samplePoint: toSamplePoint(hit.pixel, sampleSize, canvas.width, canvas.height) });
  }

  function handleLeave() {
    setPointer(null);
    onHover(null);
  }

  const loupeLeft = pointer ? (pointer.cssX + 24 + LOUPE_SIZE > pointer.boxW ? pointer.cssX - 24 - LOUPE_SIZE : pointer.cssX + 24) : 0;
  const loupeTop = pointer ? (pointer.cssY + 24 + LOUPE_SIZE > pointer.boxH ? pointer.cssY - 24 - LOUPE_SIZE : pointer.cssY + 24) : 0;

  return (
    <div className="space-y-2">
      <div className="flex min-h-[240px] items-center justify-center rounded-lg border border-border bg-[repeating-conic-gradient(#e5e5e5_0%_25%,#ffffff_0%_50%)] bg-[length:16px_16px] p-2 dark:bg-[repeating-conic-gradient(#2a2a2a_0%_25%,#1f1f1f_0%_50%)]">
        <div className="relative inline-block max-w-full">
          <canvas
            ref={canvasRef}
            role="img"
            aria-label={alt}
            data-testid="hex-label-canvas"
            className={cn(
              "block h-auto max-h-[60vh] w-auto max-w-full touch-none select-none",
              status === "ready" ? "cursor-crosshair" : "cursor-not-allowed",
              status === "loading" || status === "error" ? "invisible h-0" : ""
            )}
            onPointerMove={handleMove}
            onPointerDown={handleMove}
            onPointerUp={handleUp}
            onPointerLeave={handleLeave}
          />
          {marker && status !== "loading" && status !== "error" ? (
            <span
              aria-hidden
              className="pointer-events-none absolute size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_2px_rgba(0,0,0,0.8)]"
              style={{ left: `${marker.x * 100}%`, top: `${marker.y * 100}%` }}
            />
          ) : null}
          {pointer && status !== "loading" && status !== "error" ? (
            <canvas
              ref={loupeRef}
              width={LOUPE_SIZE}
              height={LOUPE_SIZE}
              aria-hidden
              className="pointer-events-none absolute rounded-full border-2 border-white shadow-lg"
              style={{ left: loupeLeft, top: loupeTop, width: LOUPE_SIZE, height: LOUPE_SIZE }}
            />
          ) : null}
        </div>
        {status === "loading" ? <p className="text-sm text-muted-foreground">Loading image…</p> : null}
        {status === "error" ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <ImageOff className="size-4" /> Image failed to load.
          </p>
        ) : null}
      </div>
      {status === "tainted" ? (
        <p role="alert" className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
          <span>
            This image can&apos;t be sampled: its server did not allow cross-origin pixel reads (CORS), so the canvas
            is tainted. Use the native eyedropper (E) or type the hex.
          </span>
        </p>
      ) : null}
    </div>
  );
}

// ── Per-shade editor ────────────────────────────────────────────────────────

interface ShadeLabelerProps {
  item: HexLabelQueueItem;
  threshold: number;
  sampleSize: number;
  onSampleSizeChange: (size: number) => void;
  saving: boolean;
  canUndo: boolean;
  canPrev: boolean;
  onSave: (request: HexLabelRequest) => void;
  onSkip: () => void;
  onNext: () => void;
  onPrev: () => void;
  onUndo: () => void;
}

function initialImageIndex(item: HexLabelQueueItem): number {
  const labelImage = item.label?.imageId;
  const index = labelImage ? item.images.findIndex((img) => img.imageId === labelImage) : -1;
  return index >= 0 ? index : 0;
}

function initialPick(item: HexLabelQueueItem): PickedColor | null {
  const label = item.label;
  if (!label?.hex) return null;
  return { hex: label.hex, method: label.method ?? "manual", imageId: label.imageId, samplePoint: label.samplePoint };
}

/** Keyed by shade id, so all per-shade state starts fresh (or from the saved label). */
function ShadeLabeler({
  item,
  threshold,
  sampleSize,
  onSampleSizeChange,
  saving,
  canUndo,
  canPrev,
  onSave,
  onSkip,
  onNext,
  onPrev,
  onUndo,
}: ShadeLabelerProps) {
  const [imageIndex, setImageIndex] = useState(() => initialImageIndex(item));
  const [picked, setPicked] = useState<PickedColor | null>(() => initialPick(item));
  const [hexInput, setHexInput] = useState(() => item.label?.hex ?? "");
  const [unreliable, setUnreliable] = useState(() => item.label?.unreliable ?? false);
  const [note, setNote] = useState(() => item.label?.note ?? "");
  const [hover, setHover] = useState<RegionSample | null>(null);
  const [eyeDropperSupported] = useState(() => getEyeDropperCtor() !== null);

  const activeImage: HexLabelImage | null = item.images[imageIndex] ?? null;
  const activeImageId = activeImage?.imageId ?? null;
  const typedHex = normalizeHexInput(hexInput);
  const marker = picked?.samplePoint && picked.imageId === activeImageId ? picked.samplePoint : null;

  const choosePick = useCallback((next: PickedColor) => {
    setPicked(next);
    setHexInput(next.hex);
  }, []);

  const openEyeDropper = useCallback(async () => {
    const Ctor = getEyeDropperCtor();
    if (!Ctor) {
      toast.error("EyeDropper not supported", { description: "Use a Chromium browser, or click the image." });
      return;
    }
    try {
      const result = await new Ctor().open();
      const hex = normalizeHexInput(result.sRGBHex);
      if (hex) choosePick({ hex, method: "eyedropper", imageId: activeImageId, samplePoint: null });
    } catch {
      // Cancelled with Escape.
    }
  }, [activeImageId, choosePick]);

  const submit = useCallback(() => {
    if (saving) return;
    if (!typedHex && !unreliable) {
      toast.error("No colour picked", { description: "Click the image, use the eyedropper, or type a #RRGGBB hex." });
      return;
    }
    const fromPick = Boolean(picked && typedHex && picked.hex === typedHex);
    const method: HexLabelSampleMethod | null = typedHex ? (fromPick && picked ? picked.method : "manual") : null;
    const imageId = fromPick && picked ? picked.imageId : activeImageId;
    onSave({
      shadeId: item.shadeId,
      hex: typedHex,
      imageId,
      unreliable,
      note: note.trim() || null,
      method,
      samplePoint: fromPick && picked?.method === "canvas" ? picked.samplePoint : null,
    });
  }, [activeImageId, item.shadeId, note, onSave, picked, saving, typedHex, unreliable]);

  // Keyboard shortcuts (see hexLabelKeyAction).
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      // Let a focused button handle Enter/Space itself.
      if (event.key === "Enter" && target instanceof HTMLElement && ["BUTTON", "A"].includes(target.tagName)) return;
      const action: HexLabelKeyAction | null = hexLabelKeyAction(event, {
        inTextField: isTextField(target),
        inHexInput: target instanceof HTMLElement && target.dataset.hexInput === "true",
      });
      if (!action) return;
      event.preventDefault();
      switch (action.type) {
        case "save":
          submit();
          break;
        case "skip":
          onSkip();
          break;
        case "next":
          onNext();
          break;
        case "prev":
          onPrev();
          break;
        case "undo":
          onUndo();
          break;
        case "eyedropper":
          void openEyeDropper();
          break;
        case "image":
          if (action.index < item.images.length) setImageIndex(action.index);
          break;
        case "sample-size":
          onSampleSizeChange(stepSampleSize(sampleSize, action.delta));
          break;
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [item.images.length, onNext, onPrev, onSampleSizeChange, onSkip, onUndo, openEyeDropper, sampleSize, submit]);

  const previewHex = hover?.hex ?? typedHex;
  const labelImageId = picked && typedHex === picked.hex ? picked.imageId : activeImageId;
  const pickedImageMissingUrl = Boolean(
    typedHex && labelImageId && !item.images.find((img) => img.imageId === labelImageId)?.sourceUrl
  );

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
      <section className="min-w-0 space-y-3" aria-label="Product images">
        {activeImage ? (
          <ImageSampler
            key={activeImage.url}
            src={activeImage.url}
            alt={`${item.brand} ${item.name} image ${imageIndex + 1}`}
            sampleSize={sampleSize}
            marker={marker}
            onHover={setHover}
            onPick={({ sample, samplePoint }) =>
              choosePick({ hex: sample.hex, method: "canvas", imageId: activeImage.imageId, samplePoint })
            }
          />
        ) : (
          <div className="flex min-h-[240px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border text-sm text-muted-foreground">
            <ImageOff className="size-6" />
            No catalog images for this shade. Type a hex or flag it as unreliable.
          </div>
        )}

        {item.images.length > 0 ? (
          <div className="flex flex-wrap gap-2" role="tablist" aria-label="Choose image">
            {item.images.map((image, index) => (
              <button
                key={image.imageId}
                type="button"
                role="tab"
                aria-selected={index === imageIndex}
                onClick={() => setImageIndex(index)}
                className={cn(
                  "relative size-16 overflow-hidden rounded-md border-2 bg-muted transition",
                  index === imageIndex ? "border-primary" : "border-transparent opacity-80 hover:opacity-100"
                )}
                title={`Image ${index + 1}${image.isPrimary ? " (primary)" : ""}`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- proxied thumbnails, not optimizable at build time */}
                <img src={buildSwatchThumbnailUrl(image.url, 96)} alt="" className="size-full object-cover" loading="lazy" />
                {index < 9 ? (
                  <span className="absolute left-0.5 top-0.5 rounded bg-black/70 px-1 font-mono text-[10px] text-white">{index + 1}</span>
                ) : null}
                {picked?.imageId === image.imageId ? (
                  <span className="absolute bottom-0.5 right-0.5 size-3 rounded-full border border-white" style={{ backgroundColor: picked.hex }} />
                ) : null}
              </button>
            ))}
          </div>
        ) : null}

        {activeImage ? (
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>
              Image {imageIndex + 1} of {item.images.length}
              {activeImage.isPrimary ? " · primary product image" : activeImage.swatchType ? ` · ${activeImage.swatchType}` : ""}
            </span>
            {activeImage.sourceUrl ? (
              <a href={activeImage.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline-offset-2 hover:underline">
                Vendor image <ExternalLink className="size-3" />
              </a>
            ) : (
              <span>No vendor URL recorded</span>
            )}
          </p>
        ) : null}
      </section>

      <aside className="space-y-4" aria-label="Label">
        <div className="space-y-1">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">{item.brand}</p>
          <h3 className="text-lg font-semibold leading-tight">{item.name}</h3>
          <div className="flex flex-wrap items-center gap-2">
            <FinishBadges polish={{ finishes: item.finishes }} empty={<span className="text-xs text-muted-foreground">No finish</span>} />
            {item.label ? (
              <Badge variant={item.label.unreliable ? "destructive" : "secondary"}>
                {item.label.unreliable ? "Flagged unreliable" : "Labeled"}
              </Badge>
            ) : null}
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <HexSwatch label="Vendor" hex={item.vendorHex} />
          <HexSwatch
            label="Detected"
            hex={item.detectedHex}
            detail={item.detectedHexConfidence !== null ? `${Math.round(item.detectedHexConfidence * 100)}%` : null}
          />
          <HexSwatch label="Name" hex={item.nameHex} />
        </div>
        <p className="text-xs text-muted-foreground">
          Vendor ↔ detected (OKLAB):{" "}
          {item.hexAgreement !== null ? (
            <span className={cn("font-mono", item.flagged && "font-semibold text-destructive")}>
              {item.hexAgreement.toFixed(3)}
              {item.flagged ? ` > ${threshold.toFixed(2)} disagree` : ""}
            </span>
          ) : (
            "n/a"
          )}
        </p>

        <div className="space-y-2 rounded-lg border border-border p-3">
          <div className="grid grid-cols-2 gap-2">
            <HexSwatch label={hover ? "Under cursor" : "Preview"} hex={previewHex} large />
            <HexSwatch label="Picked" hex={typedHex} large detail={picked && typedHex === picked.hex ? picked.method : typedHex ? "typed" : null} />
          </div>
          {typedHex ? (
            <p className="text-xs text-muted-foreground">
              Δ vendor <span className="font-mono">{formatDistance(typedHex, item.vendorHex) ?? "n/a"}</span> · Δ detected{" "}
              <span className="font-mono">{formatDistance(typedHex, item.detectedHex) ?? "n/a"}</span>
            </p>
          ) : null}
          <label className="block space-y-1 text-sm">
            <span className="text-xs font-medium text-muted-foreground">Hex (#RRGGBB)</span>
            <Input
              value={hexInput}
              data-hex-input="true"
              placeholder="#22BACC"
              spellCheck={false}
              autoComplete="off"
              className="font-mono"
              aria-invalid={hexInput.trim() !== "" && !typedHex}
              onChange={(event) => setHexInput(event.target.value)}
            />
          </label>

          <div className="space-y-1">
            <span className="text-xs font-medium text-muted-foreground">Sample area</span>
            <div className="flex flex-wrap items-center gap-1" role="radiogroup" aria-label="Sample area">
              {HEX_LABEL_SAMPLE_SIZES.map((size) => (
                <ToggleChip
                  key={size}
                  pressed={sampleSize === size}
                  onPressedChange={() => onSampleSizeChange(size)}
                  className="px-2 py-1 font-mono text-xs"
                  role="radio"
                  aria-checked={sampleSize === size}
                >
                  {size}×{size}
                </ToggleChip>
              ))}
              {eyeDropperSupported ? (
                <Button type="button" variant="outline" size="sm" onClick={() => void openEyeDropper()} title="Native eyedropper (E)">
                  <Pipette className="size-4" /> Eyedropper
                </Button>
              ) : null}
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={unreliable} onChange={(event) => setUnreliable(event.target.checked)} className="size-4" />
            Images unreliable (exclude from ground truth)
          </label>
          <label className="block space-y-1 text-sm">
            <span className="text-xs font-medium text-muted-foreground">Note (optional)</span>
            <textarea
              value={note}
              maxLength={1000}
              rows={2}
              onChange={(event) => setNote(event.target.value)}
              className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              placeholder="e.g. sampled the nail swatch, bottle shot is overexposed"
            />
          </label>
          {pickedImageMissingUrl ? (
            <p className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              This image has no public vendor URL, so the eval export (`eval:hex:populate`) will skip this label.
            </p>
          ) : null}

          <div className="flex flex-wrap gap-2 pt-1">
            <Button type="button" onClick={submit} disabled={saving}>
              <Save className="size-4" /> {saving ? "Saving…" : "Save"} <kbd className="ml-1 text-[10px] opacity-70">↵</kbd>
            </Button>
            <Button type="button" variant="outline" onClick={onSkip} disabled={saving}>
              <SkipForward className="size-4" /> Skip <kbd className="ml-1 text-[10px] opacity-70">S</kbd>
            </Button>
            <Button type="button" variant="ghost" onClick={onUndo} disabled={!canUndo || saving}>
              <Undo2 className="size-4" /> Undo <kbd className="ml-1 text-[10px] opacity-70">U</kbd>
            </Button>
          </div>
          <div className="flex justify-between">
            <Button type="button" variant="ghost" size="sm" onClick={onPrev} disabled={!canPrev}>
              <ChevronLeft className="size-4" /> Prev
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={onNext}>
              Next <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      </aside>
    </div>
  );
}

// ── Tab ─────────────────────────────────────────────────────────────────────

function filtersKey(filters: FilterState): string {
  return JSON.stringify(filters);
}

/**
 * Admin "Hex Labeling" tab: walk a queue of shades and pick each one's true colour from its
 * product images with a canvas eyedropper. Saves ground-truth labels for the hex-detection eval
 * (`color_training_sample`, source_type `manual`); never changes the shade's vendor/detected hex.
 */
export function HexLabelingTab() {
  const [filters, setFilters] = useState<FilterState>({
    brand: "",
    disagreeOnly: false,
    showLabeled: false,
    includeWithoutImages: false,
  });
  const [brandDraft, setBrandDraft] = useState("");
  const [queue, setQueue] = useState<QueueState | null>(null);
  const [loadError, setLoadError] = useState<{ key: string; message: string } | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [sampleSize, setSampleSize] = useState(5);
  const [saving, setSaving] = useState(false);
  const [lastSave, setLastSave] = useState<HexLabelSaveResponse | null>(null);
  const [skipped, setSkipped] = useState(0);
  const loadingMoreRef = useRef(false);

  const key = `${filtersKey(filters)}#${reloadToken}`;
  const isLoading = queue?.key !== key && loadError?.key !== key;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await getHexLabelQueue({
          brand: filters.brand || undefined,
          disagreeOnly: filters.disagreeOnly,
          showLabeled: filters.showLabeled,
          includeWithoutImages: filters.includeWithoutImages,
          pageSize: PAGE_SIZE,
        });
        if (cancelled) return;
        setQueue({
          key,
          items: response.items,
          nextCursor: response.nextCursor,
          total: response.total,
          labeled: response.labeled,
          threshold: response.disagreementThreshold,
          index: 0,
        });
        setLoadError(null);
      } catch (error) {
        if (!cancelled) setLoadError({ key, message: errorMessage(error, "Failed to load the labeling queue") });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [filters, key]);

  const current = queue && queue.key === key ? queue.items[queue.index] ?? null : null;

  // Prefetch the next page as the admin nears the end of the loaded queue.
  useEffect(() => {
    if (!queue || queue.key !== key || !queue.nextCursor || loadingMoreRef.current) return;
    if (queue.items.length - queue.index > PREFETCH_REMAINING) return;
    loadingMoreRef.current = true;
    const cursor = queue.nextCursor;
    void (async () => {
      try {
        const response = await getHexLabelQueue({
          brand: filters.brand || undefined,
          disagreeOnly: filters.disagreeOnly,
          showLabeled: filters.showLabeled,
          includeWithoutImages: filters.includeWithoutImages,
          pageSize: PAGE_SIZE,
          cursor,
        });
        setQueue((prev) =>
          prev && prev.key === key && prev.nextCursor === cursor
            ? {
                ...prev,
                items: [
                  ...prev.items,
                  ...response.items.filter((item) => !prev.items.some((existing) => existing.shadeId === item.shadeId)),
                ],
                nextCursor: response.nextCursor,
              }
            : prev
        );
      } catch (error) {
        toast.error("Failed to load more shades", { description: errorMessage(error, "Request failed") });
      } finally {
        loadingMoreRef.current = false;
      }
    })();
  }, [filters, key, queue]);

  const goTo = useCallback(
    (delta: 1 | -1) => {
      if (delta === 1 && queue && queue.index >= queue.items.length - 1 && !queue.nextCursor) {
        toast.info("End of the queue", { description: "Change the filters or turn on “Show labeled” to review." });
      }
      setQueue((prev) => {
        if (!prev) return prev;
        const index = Math.min(prev.items.length - 1, Math.max(0, prev.index + delta));
        return index === prev.index ? prev : { ...prev, index };
      });
    },
    [queue]
  );

  const handleNext = useCallback(() => goTo(1), [goTo]);
  const handlePrev = useCallback(() => goTo(-1), [goTo]);
  const handleSkip = useCallback(() => {
    setSkipped((count) => count + 1);
    goTo(1);
  }, [goTo]);

  /** Replace one shade's label in the loaded queue and keep the progress count in sync. */
  const applyLabel = useCallback((shadeId: string, label: HexLabelQueueItem["label"]) => {
    setQueue((prev) => {
      if (!prev) return prev;
      let delta = 0;
      const items = prev.items.map((item) => {
        if (item.shadeId !== shadeId) return item;
        delta = (label ? 1 : 0) - (item.label ? 1 : 0);
        return { ...item, label };
      });
      return { ...prev, items, labeled: Math.max(0, prev.labeled + delta) };
    });
  }, []);

  const handleSave = useCallback(
    async (request: HexLabelRequest) => {
      setSaving(true);
      try {
        const response = await saveHexLabel(request);
        applyLabel(response.label.shadeId, response.label);
        setLastSave(response);
        toast.success(response.label.unreliable ? "Flagged as unreliable" : `Saved ${response.label.hex}`, {
          description: response.previous ? "Replaced the previous label." : undefined,
        });
        goTo(1);
      } catch (error) {
        toast.error("Failed to save label", { description: errorMessage(error, "Request failed") });
      } finally {
        setSaving(false);
      }
    },
    [applyLabel, goTo]
  );

  const handleUndo = useCallback(async () => {
    if (!lastSave || saving) return;
    const plan = planUndo(lastSave);
    setSaving(true);
    try {
      if (plan.kind === "delete") {
        await deleteHexLabel(plan.trainingSampleId);
        applyLabel(plan.shadeId, null);
      } else {
        const restored = await saveHexLabel(plan.request);
        applyLabel(plan.shadeId, restored.label);
      }
      setLastSave(null);
      setQueue((prev) => {
        if (!prev) return prev;
        const index = prev.items.findIndex((item) => item.shadeId === plan.shadeId);
        return index >= 0 ? { ...prev, index } : prev;
      });
      toast.success(plan.kind === "delete" ? "Label removed" : "Previous label restored");
    } catch (error) {
      toast.error("Undo failed", { description: errorMessage(error, "Request failed") });
    } finally {
      setSaving(false);
    }
  }, [applyLabel, lastSave, saving]);

  const progress = useMemo(() => labelProgress(queue?.labeled ?? 0, queue?.total ?? 0), [queue?.labeled, queue?.total]);

  function applyBrand() {
    const brand = brandDraft.trim();
    if (brand !== filters.brand) setFilters((prev) => ({ ...prev, brand }));
  }

  return (
    <div className="space-y-4" data-testid="hex-labeling-tab">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">Hex Labeling</h2>
        <p className="text-sm text-muted-foreground">
          Pick each polish&apos;s true colour from its product images to build ground truth for the hex-detection
          eval (<code className="text-xs">npm run eval:hex:populate -- --source-type manual</code>). Labels never change a
          shade&apos;s vendor or detected hex.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            applyBrand();
          }}
        >
          <Input
            value={brandDraft}
            onChange={(event) => setBrandDraft(event.target.value)}
            onBlur={applyBrand}
            placeholder="Filter by brand"
            aria-label="Filter by brand"
            className="h-8 w-44"
          />
        </form>
        <ToggleChip pressed={filters.disagreeOnly} onPressedChange={(disagreeOnly) => setFilters((prev) => ({ ...prev, disagreeOnly }))}>
          Vendor ≠ detected
        </ToggleChip>
        <ToggleChip pressed={filters.showLabeled} onPressedChange={(showLabeled) => setFilters((prev) => ({ ...prev, showLabeled }))}>
          Show labeled
        </ToggleChip>
        <ToggleChip
          pressed={filters.includeWithoutImages}
          onPressedChange={(includeWithoutImages) => setFilters((prev) => ({ ...prev, includeWithoutImages }))}
        >
          Include no-image shades
        </ToggleChip>
      </div>

      <div className="space-y-1">
        <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
          <span>
            <span className="font-semibold">{progress.labeled}</span> / {progress.total} labeled ({progress.percent}%)
            {skipped > 0 ? <span className="text-muted-foreground"> · {skipped} skipped this session</span> : null}
          </span>
          {queue && queue.key === key && queue.items.length > 0 ? (
            <span className="text-xs text-muted-foreground">
              Shade {queue.index + 1} of {queue.items.length}
              {queue.nextCursor ? "+" : ""} in queue
            </span>
          ) : null}
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent}>
          <div className="h-full bg-primary transition-all" style={{ width: `${progress.percent}%` }} />
        </div>
      </div>

      {isLoading ? (
        <p className="py-12 text-center text-sm text-muted-foreground">Loading queue…</p>
      ) : loadError?.key === key ? (
        <div className="space-y-2 py-8 text-center">
          <p className="text-sm text-destructive">{loadError.message}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => setReloadToken((token) => token + 1)}>
            Retry
          </Button>
        </div>
      ) : current && queue ? (
        <ShadeLabeler
          key={current.shadeId}
          item={current}
          threshold={queue.threshold}
          sampleSize={sampleSize}
          onSampleSizeChange={setSampleSize}
          saving={saving}
          canUndo={lastSave !== null}
          canPrev={queue.index > 0}
          onSave={handleSave}
          onSkip={handleSkip}
          onNext={handleNext}
          onPrev={handlePrev}
          onUndo={handleUndo}
        />
      ) : (
        <p className="py-12 text-center text-sm text-muted-foreground">
          Nothing to label with these filters. Try another brand or turn on “Show labeled”.
        </p>
      )}

      <p className="text-xs text-muted-foreground">
        Shortcuts: click/tap the image to sample · <kbd>Enter</kbd> save · <kbd>S</kbd> skip · <kbd>N</kbd>/<kbd>→</kbd> next ·{" "}
        <kbd>P</kbd>/<kbd>←</kbd> previous · <kbd>1</kbd>–<kbd>9</kbd> image · <kbd>[</kbd>/<kbd>]</kbd> sample size ·{" "}
        <kbd>E</kbd> eyedropper · <kbd>U</kbd> undo
      </p>
    </div>
  );
}
