"use client";

import { useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import type { ExtractedColor, PolishMatch } from "swatchwatch-shared";
import { resolveDisplayHex } from "swatchwatch-shared";
import { Camera, ImageUp, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ColorDot } from "@/components/color-dot";
import { finishBadgeClassName, finishLabel } from "@/lib/constants";
import { SwatchThumbnail } from "@/components/swatch-thumbnail";
import { cn } from "@/lib/utils";
import { CONFIDENCE_META, formatFraction, matchPercent } from "./match-utils";

// ── Upload ───────────────────────────────────────────────────────────────────

type ImageDropZoneProps = {
  onFile: (file: File) => void;
  disabled?: boolean;
  /** Compact variant shown once an image has been chosen. */
  compact?: boolean;
};

/**
 * Drag-and-drop target plus "Choose photo" (library/file picker) and
 * "Take photo" (rear camera on phones via `capture`) buttons.
 */
export function ImageDropZone({ onFile, disabled = false, compact = false }: ImageDropZoneProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  function handleFiles(files: FileList | null) {
    const file = files?.[0];
    if (file) onFile(file);
  }

  const buttons = (
    <div className="flex flex-wrap items-center justify-center gap-2">
      <Button
        type="button"
        variant={compact ? "outline" : "default"}
        size={compact ? "sm" : "default"}
        disabled={disabled}
        onClick={() => fileInputRef.current?.click()}
        className={compact ? undefined : "bg-gradient-brand text-white shadow-glow-brand hover:opacity-90"}
      >
        <Upload aria-hidden="true" />
        {compact ? "Choose another" : "Choose photo"}
      </Button>
      <Button
        type="button"
        variant="outline"
        size={compact ? "sm" : "default"}
        disabled={disabled}
        onClick={() => cameraInputRef.current?.click()}
      >
        <Camera aria-hidden="true" />
        Take photo
      </Button>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          handleFiles(event.target.files);
          event.target.value = "";
        }}
      />
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          handleFiles(event.target.files);
          event.target.value = "";
        }}
      />
    </div>
  );

  if (compact) return buttons;

  return (
    <div
      onDragOver={(event) => {
        event.preventDefault();
        if (!disabled) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        if (!disabled) handleFiles(event.dataTransfer.files);
      }}
      className={cn(
        "flex min-h-[260px] flex-col items-center justify-center gap-4 rounded-2xl border-2 border-dashed px-6 py-10 text-center transition-colors",
        dragging
          ? "border-brand-purple bg-brand-pink-light/40 dark:bg-brand-purple/20"
          : "border-brand-purple/25 bg-muted/30",
      )}
    >
      <div className="inline-flex size-14 items-center justify-center rounded-full bg-gradient-brand-soft shadow-glow-brand">
        <ImageUp className="size-6 text-brand-purple-deep dark:text-brand-lilac" aria-hidden="true" />
      </div>
      <div>
        <p className="font-semibold">Drop a photo here</p>
        <p className="mt-1 text-sm text-muted-foreground">
          An outfit, flowers, a logo — anything with colors you want to match.
        </p>
      </div>
      {buttons}
      <p className="text-xs text-muted-foreground">
        Your photo is analyzed in memory and never saved.
      </p>
    </div>
  );
}

// ── Preview ──────────────────────────────────────────────────────────────────

export function ImagePreview({ src, width, height }: { src: string; width: number; height: number }) {
  return (
    <Image
      src={src}
      alt="Uploaded photo"
      width={width}
      height={height}
      unoptimized
      className="mx-auto max-h-80 w-auto rounded-xl border object-contain"
    />
  );
}

// ── Palette ──────────────────────────────────────────────────────────────────

type ExtractedPaletteProps = {
  colors: ExtractedColor[];
  selectedHex: string | null;
  matchCounts: Map<string, number>;
  onSelect: (hex: string | null) => void;
};

/** Clickable swatches for each extracted color; clicking filters the results to that color. */
export function ExtractedPalette({ colors, selectedHex, matchCounts, onSelect }: ExtractedPaletteProps) {
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label="Extracted colors">
      <button
        type="button"
        onClick={() => onSelect(null)}
        aria-pressed={selectedHex === null}
        className={cn(
          "inline-flex h-16 items-center rounded-xl border px-3 text-sm font-medium transition-all",
          selectedHex === null
            ? "border-brand-purple/50 bg-brand-pink-light/60 text-brand-purple-deep ring-2 ring-brand-purple/40 dark:bg-brand-purple/30 dark:text-brand-lilac"
            : "border-border hover:border-brand-purple/30",
        )}
      >
        All colors
      </button>
      {colors.map((color) => {
        const selected = selectedHex?.toUpperCase() === color.hex.toUpperCase();
        const count = matchCounts.get(color.hex.toUpperCase()) ?? 0;
        return (
          <button
            key={color.hex}
            type="button"
            onClick={() => onSelect(selected ? null : color.hex)}
            aria-pressed={selected}
            aria-label={`${color.hex}, ${formatFraction(color.fraction)} of image, ${count} matches`}
            title={`${color.hex} · ${formatFraction(color.fraction)} of image`}
            className={cn(
              "group flex h-16 w-20 flex-col overflow-hidden rounded-xl border text-left transition-all",
              selected
                ? "border-brand-purple ring-2 ring-brand-purple/60 shadow-glow-brand"
                : "border-border hover:-translate-y-0.5 hover:shadow-glow-purple",
            )}
          >
            <span className="block flex-1" style={{ backgroundColor: color.hex }} />
            <span className="flex items-center justify-between gap-1 bg-card px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
              <span>{formatFraction(color.fraction)}</span>
              <span>{count}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ── Results ──────────────────────────────────────────────────────────────────

export function ConfidenceBadge({ confidence }: { confidence: PolishMatch["confidence"] }) {
  const meta = CONFIDENCE_META[confidence];
  return (
    <Badge className={cn("shrink-0", meta.badgeClassName)} title={meta.description}>
      {meta.label}
    </Badge>
  );
}

/** Ranked match rows: swatch, polish color → matched photo color, name/brand, finish, confidence. */
export function MatchResultsList({ matches }: { matches: PolishMatch[] }) {
  return (
    <ul className="space-y-1">
      {matches.map(({ polish, matchedColor, distance, confidence }) => {
        const polishHex = resolveDisplayHex(polish);
        return (
          <li key={polish.id}>
            <Link
              href={`/polishes/detail?id=${polish.id}`}
              className="flex items-center gap-3 rounded-md p-2 transition-colors hover:bg-muted"
            >
              {polish.swatchImageUrl ? (
                <SwatchThumbnail
                  src={polish.swatchImageUrl}
                  displaySize={40}
                  alt={`${polish.brand} ${polish.name} swatch`}
                  className="h-10 w-10 shrink-0 rounded-md border object-cover"
                />
              ) : (
                <div className="h-10 w-10 shrink-0 rounded-md border bg-muted/40" />
              )}
              <span
                className="flex shrink-0 items-center gap-1"
                title={`Polish ${polishHex ?? "—"} vs photo ${matchedColor}`}
              >
                <ColorDot hex={polishHex} size="md" />
                <span className="text-xs text-muted-foreground" aria-hidden="true">≈</span>
                <ColorDot hex={matchedColor} size="sm" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{polish.name}</p>
                <p className="truncate text-sm text-muted-foreground">
                  {polish.brand}
                  {polish.collection ? ` · ${polish.collection}` : ""}
                </p>
              </div>
              {polish.finish && (
                <Badge className={cn("hidden shrink-0 sm:inline-flex", finishBadgeClassName(polish.finish))}>
                  {finishLabel(polish.finish)}
                </Badge>
              )}
              <ConfidenceBadge confidence={confidence} />
              <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                {matchPercent(distance)}%
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
