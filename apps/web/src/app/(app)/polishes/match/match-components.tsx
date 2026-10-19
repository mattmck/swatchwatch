"use client";

import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import type { ExtractedColor, MatchConfidence, PolishMatch } from "swatchwatch-shared";
import { resolveDisplayHex } from "swatchwatch-shared";
import { Camera, Crop, EyeOff, ImageUp, Upload, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ColorDot } from "@/components/color-dot";
import { POLISH_STATUS_LABELS } from "@/lib/inventory-status";
import { finishBadgeClassName, finishLabel } from "@/lib/constants";
import { regionFromDrag, regionStyle, type ImageRegion, type Point } from "@/lib/image-region";
import {
  PALETTE_KIND_LABELS,
  paletteChipState,
  paletteColorKind,
  type PaletteSelection,
} from "@/lib/photo-match";
import { SwatchThumbnail } from "@/components/swatch-thumbnail";
import { cn } from "@/lib/utils";
import { CONFIDENCE_META, formatFraction, matchPercent } from "./match-utils";
import { detailHref } from "@/lib/detail-href";

// ── Upload ───────────────────────────────────────────────────────────────────

/** How the photo was picked (`upload` also covers drag-and-drop). */
export type ImageSource = "upload" | "camera";

type ImageDropZoneProps = {
  onFile: (file: File, source: ImageSource) => void;
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

  function handleFiles(files: FileList | null, source: ImageSource) {
    const file = files?.[0];
    if (file) onFile(file, source);
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
          handleFiles(event.target.files, "upload");
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
          handleFiles(event.target.files, "camera");
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
        if (!disabled) handleFiles(event.dataTransfer.files, "upload");
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

// ── Preview + region selection ───────────────────────────────────────────────

type RegionPreviewProps = {
  src: string;
  width: number;
  height: number;
  /** The drawn box, if any (image fractions). */
  region: ImageRegion | null;
  onRegionChange: (region: ImageRegion | null) => void;
  disabled?: boolean;
};

/**
 * The photo, with "drag to focus on an area" (#105 Phase 5 region selection). Dragging draws a
 * box in image fractions; a click without dragging clears it. Pointer events cover mouse,
 * touch and pen (`touch-none` stops the page from scrolling while drawing).
 */
export function RegionPreview({ src, width, height, region, onRegionChange, disabled = false }: RegionPreviewProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const startRef = useRef<Point | null>(null);
  const [draft, setDraft] = useState<ImageRegion | null>(null);

  function pointFor(event: ReactPointerEvent<HTMLDivElement>): { point: Point; width: number; height: number } | null {
    const rect = frameRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return { point: { x: event.clientX - rect.left, y: event.clientY - rect.top }, width: rect.width, height: rect.height };
  }

  const shown = draft ?? region;

  return (
    <div
      ref={frameRef}
      className={cn(
        "relative mx-auto w-fit max-w-full select-none overflow-hidden rounded-xl border",
        !disabled && "cursor-crosshair touch-none"
      )}
      onPointerDown={(event) => {
        if (disabled || event.button !== 0) return;
        const at = pointFor(event);
        if (!at) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        startRef.current = at.point;
        setDraft(null);
      }}
      onPointerMove={(event) => {
        const start = startRef.current;
        const at = pointFor(event);
        if (!start || !at) return;
        setDraft(regionFromDrag(start, at.point, at.width, at.height));
      }}
      onPointerUp={(event) => {
        const start = startRef.current;
        const at = pointFor(event);
        startRef.current = null;
        setDraft(null);
        if (!start || !at) return;
        onRegionChange(regionFromDrag(start, at.point, at.width, at.height));
      }}
      onPointerCancel={() => {
        startRef.current = null;
        setDraft(null);
      }}
    >
      <Image
        src={src}
        alt="Uploaded photo"
        width={width}
        height={height}
        unoptimized
        draggable={false}
        className="block h-auto max-h-80 w-auto max-w-full object-contain"
      />
      {shown && (
        // The huge spread shadow dims everything outside the box (the frame clips it).
        <div
          className="pointer-events-none absolute rounded-sm border-2 border-white shadow-[0_0_0_9999px_rgba(0,0,0,0.4)]"
          style={regionStyle(shown)}
          aria-hidden="true"
        />
      )}
    </div>
  );
}

// ── Palette ──────────────────────────────────────────────────────────────────

type ExtractedPaletteProps = {
  colors: ExtractedColor[];
  selection: PaletteSelection;
  /** Matches per color (shown on the chip). */
  matchCounts: Map<string, number>;
  onToggle: (hex: string) => void;
};

/**
 * One chip per extracted color. Tapping a chip takes it out of matching (or puts it back);
 * background and skin colors start hidden (dashed, dimmed) and can be tapped back in.
 */
export function ExtractedPalette({ colors, selection, matchCounts, onToggle }: ExtractedPaletteProps) {
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label="Colors used for matching">
      {colors.map((color) => {
        const state = paletteChipState(color, colors, selection);
        const active = state === "active";
        const kind = paletteColorKind(color);
        const count = matchCounts.get(color.hex.toUpperCase()) ?? 0;
        const stateLabel =
          state === "dropped" ? "removed" : state === "hidden" ? `hidden (${PALETTE_KIND_LABELS[kind].toLowerCase()})` : "used";
        return (
          <button
            key={color.hex}
            type="button"
            onClick={() => onToggle(color.hex)}
            aria-pressed={active}
            aria-label={`${color.hex}, ${formatFraction(color.fraction)} of photo, ${stateLabel}. ${active ? "Tap to stop matching this color" : "Tap to match this color"}`}
            title={`${color.hex} · ${formatFraction(color.fraction)} of photo · ${active ? "tap to remove" : "tap to use"}`}
            className={cn(
              "group relative flex h-16 w-20 flex-col overflow-hidden rounded-xl border text-left transition-all",
              active
                ? "border-brand-purple/40 hover:-translate-y-0.5 hover:shadow-glow-purple"
                : "border-dashed border-muted-foreground/40 opacity-55 hover:opacity-90",
            )}
          >
            <span className="relative block flex-1" style={{ backgroundColor: color.hex }}>
              {state === "dropped" && (
                <span className="absolute inset-0 flex items-center justify-center bg-background/40">
                  <X className="size-5 text-foreground/80" aria-hidden="true" />
                </span>
              )}
              {state === "hidden" && (
                <span className="absolute inset-0 flex items-center justify-center bg-background/30">
                  <EyeOff className="size-4 text-foreground/70" aria-hidden="true" />
                </span>
              )}
            </span>
            <span className="flex items-center justify-between gap-1 bg-card px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
              <span>{state === "hidden" ? PALETTE_KIND_LABELS[kind] : formatFraction(color.fraction)}</span>
              {active && <span>{count}</span>}
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

/** What each confidence badge means, shown above the results. */
export function ConfidenceLegend({ counts }: { counts?: Record<MatchConfidence, number> }) {
  const grades: MatchConfidence[] = ["high", "medium", "low"];
  return (
    <dl className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground" aria-label="Match confidence legend">
      {grades.map((grade) => (
        <div key={grade} className="flex items-center gap-2">
          <dt>
            <ConfidenceBadge confidence={grade} />
          </dt>
          <dd>
            {CONFIDENCE_META[grade].description}
            {counts ? <span className="tabular-nums"> · {counts[grade]}</span> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

type MatchResultsListProps = {
  matches: PolishMatch[];
  /** Row actions (wishlist / own / menu), rendered outside the detail link. */
  renderActions?: (match: PolishMatch, rank: number) => ReactNode;
  /** The detail link of a row was followed. */
  onOpen?: (match: PolishMatch, rank: number) => void;
  /** Hide the photo color dot (the per-color view already shows it in the header). */
  hideMatchedColor?: boolean;
};

/** Ranked match rows: swatch, polish color ≈ photo color, name/brand, status, finish, confidence, actions. */
export function MatchResultsList({ matches, renderActions, onOpen, hideMatchedColor = false }: MatchResultsListProps) {
  return (
    <ul className="@container space-y-1">
      {matches.map((match, index) => {
        const { polish, matchedColor, distance, confidence } = match;
        const polishHex = resolveDisplayHex(polish);
        const rank = index + 1;
        return (
          <li key={polish.id} className="flex flex-wrap items-center gap-x-2 rounded-md transition-colors hover:bg-muted">
            <Link
              href={detailHref(polish.id)}
              onClick={() => onOpen?.(match, rank)}
              className="flex min-w-[14rem] flex-1 items-center gap-3 overflow-hidden p-2"
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
                className="hidden shrink-0 items-center gap-1 @sm:flex"
                title={`Polish ${polishHex ?? "—"} vs photo ${matchedColor}`}
              >
                <ColorDot hex={polishHex} size="md" />
                {!hideMatchedColor && (
                  <>
                    <span className="text-xs text-muted-foreground" aria-hidden="true">≈</span>
                    <ColorDot hex={matchedColor} size="sm" />
                  </>
                )}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{polish.name}</p>
                <p className="truncate text-sm text-muted-foreground">
                  {polish.brand}
                  {polish.collection ? ` · ${polish.collection}` : ""}
                </p>
                <div className="mt-1 flex items-center gap-2 @md:hidden">
                  <ConfidenceBadge confidence={confidence} />
                  <span className="text-xs tabular-nums text-muted-foreground">{matchPercent(distance)}%</span>
                </div>
              </div>
              {polish.status && polish.status !== "owned" && (
                <Badge variant="outline" className="hidden shrink-0 @lg:inline-flex">
                  {POLISH_STATUS_LABELS[polish.status]}
                </Badge>
              )}
              {polish.finish && (
                <Badge className={cn("hidden shrink-0 @2xl:inline-flex", finishBadgeClassName(polish.finish))}>
                  {finishLabel(polish.finish)}
                </Badge>
              )}
              <span className="hidden shrink-0 items-center gap-2 @md:flex">
                <ConfidenceBadge confidence={confidence} />
                <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">
                  {matchPercent(distance)}%
                </span>
              </span>
            </Link>
            {renderActions && <div className="ml-auto shrink-0 px-2 py-1">{renderActions(match, rank)}</div>}
          </li>
        );
      })}
    </ul>
  );
}

// ── Region controls ──────────────────────────────────────────────────────────

type RegionControlsProps = {
  region: ImageRegion | null;
  /** True when the current results describe a cropped area. */
  focused: boolean;
  disabled?: boolean;
  onMatchRegion: () => void;
  onClearRegion: () => void;
  onUseWholePhoto: () => void;
};

export function RegionControls({ region, focused, disabled, onMatchRegion, onClearRegion, onUseWholePhoto }: RegionControlsProps) {
  if (region) {
    return (
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button type="button" size="sm" disabled={disabled} onClick={onMatchRegion}>
          <Crop aria-hidden="true" />
          Match this area
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={onClearRegion}>
          Cancel
        </Button>
      </div>
    );
  }
  if (focused) {
    return (
      <div className="flex flex-wrap items-center justify-center gap-2 text-xs text-muted-foreground">
        <span>Matching the area you picked.</span>
        <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={onUseWholePhoto}>
          Use whole photo
        </Button>
      </div>
    );
  }
  return (
    <p className="text-center text-xs text-muted-foreground">
      Tip: drag across the photo to match just one area, like a single nail.
    </p>
  );
}

// ── Empty state ──────────────────────────────────────────────────────────────

type MatchEmptyStateProps = {
  title: string;
  description: string;
  /** Primary button (an in-page action such as switching scope). */
  actionLabel?: string;
  onAction?: () => void;
  /** Optional secondary link (for example "+ Add Polish"). */
  linkLabel?: string;
  linkHref?: string;
};

/** Compact empty state for the results card, with an in-page action and an optional link. */
export function MatchEmptyState({ title, description, actionLabel, onAction, linkLabel, linkHref }: MatchEmptyStateProps) {
  return (
    <div className="flex min-h-[200px] flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-brand-purple/25 bg-muted/20 px-4 py-8 text-center">
      <div>
        <p className="font-semibold text-foreground">{title}</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{description}</p>
      </div>
      {(actionLabel || linkLabel) && (
        <div className="flex flex-wrap items-center justify-center gap-2">
          {actionLabel && onAction && (
            <Button type="button" size="sm" onClick={onAction} className="bg-gradient-brand text-white shadow-glow-brand hover:opacity-90">
              {actionLabel}
            </Button>
          )}
          {linkLabel && linkHref && (
            <Button asChild size="sm" variant="outline">
              <Link href={linkHref}>{linkLabel}</Link>
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
