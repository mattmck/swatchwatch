"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ImageOff } from "lucide-react";
import { toast } from "sonner";
import { colorDistance, type HexLabelSamplePoint } from "swatchwatch-shared";
import {
  averageRegion,
  clientToPixel,
  loupeRadiusFor,
  normalizeHexInput,
  readableTextColor,
  sampleWindowBounds,
  toSamplePoint,
  type RegionSample,
} from "@/lib/hex-sampling";
import { cn } from "@/lib/utils";

// Shared canvas eyedropper pieces for ground-truth hex labelling: used by the admin Hex Labeling
// tab and by the admin sampler on the polish detail page (#351). Pure helpers live in
// `@/lib/hex-sampling`.

/**
 * Loupe: (2 * radius + 1) image pixels shown at LOUPE_SIZE CSS pixels. The radius is at least
 * LOUPE_RADIUS and grows with the sample window (`loupeRadiusFor`) so large windows stay visible.
 */
const LOUPE_RADIUS = 7;
const LOUPE_SIZE = 150;

export interface EyeDropperLike {
  open(): Promise<{ sRGBHex: string }>;
}

export function getEyeDropperCtor(): (new () => EyeDropperLike) | null {
  if (typeof window === "undefined") return null;
  const ctor = (window as unknown as { EyeDropper?: new () => EyeDropperLike }).EyeDropper;
  return typeof ctor === "function" ? ctor : null;
}

export function formatDistance(a: string | null | undefined, b: string | null | undefined): string | null {
  const ha = normalizeHexInput(a);
  const hb = normalizeHexInput(b);
  if (!ha || !hb) return null;
  return colorDistance(ha, hb).toFixed(3);
}

export function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.tagName === "TEXTAREA" || target.tagName === "SELECT") return true;
  // Checkboxes, buttons and the like take no typing, so shortcuts stay active there.
  if (target instanceof HTMLInputElement) {
    return !["checkbox", "radio", "button", "submit", "reset", "range", "color"].includes(target.type);
  }
  return false;
}

// ── Swatch ──────────────────────────────────────────────────────────────────

export function HexSwatch({ label, hex, detail, large }: { label: string; hex: string | null; detail?: string | null; large?: boolean }) {
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

export type ImageStatus = "loading" | "ready" | "tainted" | "error";

export interface SamplerPick {
  sample: RegionSample;
  samplePoint: HexLabelSamplePoint;
}

/**
 * CSS box for the sample-window outline: the clamped pixel bounds scaled to the displayed canvas,
 * never extending past it. No minimum size: the outline covers exactly the averaged pixels (its
 * 1px border keeps even a sub-pixel window visible).
 */
function outlineStyle(
  bounds: { x0: number; y0: number; x1: number; y1: number },
  scale: number,
  boxW: number,
  boxH: number
): { left: number; top: number; width: number; height: number } {
  const left = bounds.x0 * scale;
  const top = bounds.y0 * scale;
  return {
    left,
    top,
    width: Math.min((bounds.x1 - bounds.x0 + 1) * scale, Math.max(0, boxW - left)),
    height: Math.min((bounds.y1 - bounds.y0 + 1) * scale, Math.max(0, boxH - top)),
  };
}

/**
 * Draws one product image into a canvas and samples an averaged `sampleSize`×`sampleSize` area
 * under the pointer. Images load with `crossOrigin="anonymous"` (the image proxy answers with
 * Access-Control-Allow-Origin for the web origin); if that fails, the image is shown without CORS
 * and sampling is disabled with an explanation (the native eyedropper still works).
 * Keyed by `src` by the parent, so each image starts in `loading`.
 */
export function ImageSampler({
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
  const [pointer, setPointer] = useState<{
    cssX: number;
    cssY: number;
    px: number;
    py: number;
    boxW: number;
    boxH: number;
    /** CSS pixels per image pixel (the canvas is shown scaled to fit). */
    scale: number;
    /** Natural image size (canvas pixels). */
    imageW: number;
    imageH: number;
  } | null>(null);

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
    const radius = loupeRadiusFor(sampleSize, LOUPE_RADIUS);
    const span = radius * 2 + 1;
    const cell = LOUPE_SIZE / span;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, LOUPE_SIZE, LOUPE_SIZE);
    ctx.fillStyle = "#808080";
    ctx.fillRect(0, 0, LOUPE_SIZE, LOUPE_SIZE);
    ctx.drawImage(canvas, pointer.px - radius, pointer.py - radius, span, span, 0, 0, LOUPE_SIZE, LOUPE_SIZE);
    const half = Math.floor(sampleSize / 2);
    const start = (radius - half) * cell;
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
        scale: canvas.width > 0 ? rect.width / canvas.width : 1,
        imageW: canvas.width,
        imageH: canvas.height,
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
    setPointer({
      cssX: hit.cssX,
      cssY: hit.cssY,
      px: hit.pixel.x,
      py: hit.pixel.y,
      boxW: hit.boxW,
      boxH: hit.boxH,
      scale: hit.scale,
      imageW: hit.imageW,
      imageH: hit.imageH,
    });
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

  const sampleBounds =
    pointer && status === "ready" && sampleSize > 1
      ? sampleWindowBounds(pointer.px, pointer.py, sampleSize, pointer.imageW, pointer.imageH)
      : null;
  const sampleOutline =
    pointer && sampleBounds ? outlineStyle(sampleBounds, pointer.scale, pointer.boxW, pointer.boxH) : null;

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
          {sampleOutline ? (
            // The sample window outlined on the image itself, so large windows are easy to place
            // inside the polish (away from the cap, label and highlights). Clamped to the image
            // exactly like averageRegion, so it shows only the pixels that are averaged.
            <span
              aria-hidden
              data-testid="hex-label-sample-window"
              className="pointer-events-none absolute border border-white shadow-[0_0_0_1px_rgba(0,0,0,0.8)]"
              style={sampleOutline}
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
