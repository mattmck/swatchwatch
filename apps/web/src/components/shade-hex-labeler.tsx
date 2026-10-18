"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  ImageOff,
  Pipette,
  Save,
  SkipForward,
  Trash2,
  Undo2,
} from "lucide-react";
import { toast } from "sonner";
import type {
  HexLabelImage,
  HexLabelQueueItem,
  HexLabelRequest,
  HexLabelSampleMethod,
  HexLabelSamplePoint,
} from "swatchwatch-shared";
import {
  HEX_LABEL_SAMPLE_SIZES,
  hexLabelKeyAction,
  normalizeHexInput,
  stepSampleSize,
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
import { HexSwatch, ImageSampler, formatDistance, getEyeDropperCtor, isTextField } from "@/components/hex-sampler";

/** A pick awaiting save: where the colour came from. */
export interface PickedColor {
  hex: string;
  method: HexLabelSampleMethod;
  imageId: string | null;
  samplePoint: HexLabelSamplePoint | null;
}

export interface ShadeLabelerProps {
  item: HexLabelQueueItem;
  threshold: number;
  sampleSize: number;
  onSampleSizeChange: (size: number) => void;
  saving: boolean;
  onSave: (request: HexLabelRequest) => void;
  /**
   * Queue navigation and undo (the Hex Labeling tab). Each is optional: without a handler its
   * button is hidden and its shortcut does nothing (the polish detail page has no queue).
   */
  canUndo?: boolean;
  canPrev?: boolean;
  onSkip?: () => void;
  onNext?: () => void;
  onPrev?: () => void;
  onUndo?: () => void;
  /** Delete the saved label; the button shows only while the shade has one. */
  onRemove?: () => void;
  /** `split`: images beside the label panel from `lg` up (tab). `stacked`: one column (narrow hosts). */
  layout?: "split" | "stacked";
  /**
   * Where keyboard shortcuts listen. `window` (tab): anywhere on the page. `panel` (embedded):
   * only while focus is inside this component, so page typing and scrolling are never hijacked.
   */
  shortcutScope?: "window" | "panel";
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
export function ShadeLabeler({
  item,
  threshold,
  sampleSize,
  onSampleSizeChange,
  saving,
  canUndo = false,
  canPrev = false,
  onSave,
  onSkip,
  onNext,
  onPrev,
  onUndo,
  onRemove,
  layout = "split",
  shortcutScope = "window",
}: ShadeLabelerProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
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
    const scope: HTMLElement | Window | null = shortcutScope === "panel" ? rootRef.current : window;
    if (!scope) return;
    function onKeyDown(event: Event) {
      if (!(event instanceof KeyboardEvent)) return;
      const target = event.target as HTMLElement | null;
      // Let a focused button handle Enter/Space itself.
      if (event.key === "Enter" && target instanceof HTMLElement && ["BUTTON", "A"].includes(target.tagName)) return;
      const action: HexLabelKeyAction | null = hexLabelKeyAction(event, {
        inTextField: isTextField(target),
        inHexInput: target instanceof HTMLElement && target.dataset.hexInput === "true",
      });
      if (!action) return;
      // Navigation/undo without a handler (embedded use) leave the key alone.
      if (
        (action.type === "skip" && !onSkip) ||
        (action.type === "next" && !onNext) ||
        (action.type === "prev" && !onPrev) ||
        (action.type === "undo" && !onUndo)
      ) {
        return;
      }
      event.preventDefault();
      switch (action.type) {
        case "save":
          submit();
          break;
        case "skip":
          onSkip?.();
          break;
        case "next":
          onNext?.();
          break;
        case "prev":
          onPrev?.();
          break;
        case "undo":
          onUndo?.();
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
    scope.addEventListener("keydown", onKeyDown);
    return () => scope.removeEventListener("keydown", onKeyDown);
  }, [item.images.length, onNext, onPrev, onSampleSizeChange, onSkip, onUndo, openEyeDropper, sampleSize, shortcutScope, submit]);

  const previewHex = hover?.hex ?? typedHex;
  const labelImageId = picked && typedHex === picked.hex ? picked.imageId : activeImageId;
  const pickedImageMissingUrl = Boolean(
    typedHex && labelImageId && !item.images.find((img) => img.imageId === labelImageId)?.sourceUrl
  );

  return (
    <div
      ref={rootRef}
      tabIndex={shortcutScope === "panel" ? -1 : undefined}
      className={cn("grid gap-4 outline-none", layout === "split" && "lg:grid-cols-[minmax(0,1fr)_340px]")}
    >
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
              <span className="font-mono">{formatDistance(typedHex, item.detectedHex) ?? "n/a"}</span> · Δ name{" "}
              <span className="font-mono">{formatDistance(typedHex, item.nameHex) ?? "n/a"}</span>
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
            {onSkip ? (
              <Button type="button" variant="outline" onClick={onSkip} disabled={saving}>
                <SkipForward className="size-4" /> Skip <kbd className="ml-1 text-[10px] opacity-70">S</kbd>
              </Button>
            ) : null}
            {onUndo ? (
              <Button type="button" variant="ghost" onClick={onUndo} disabled={!canUndo || saving}>
                <Undo2 className="size-4" /> Undo <kbd className="ml-1 text-[10px] opacity-70">U</kbd>
              </Button>
            ) : null}
            {onRemove && item.label ? (
              <Button type="button" variant="outline" onClick={onRemove} disabled={saving}>
                <Trash2 className="size-4" /> Remove label
              </Button>
            ) : null}
          </div>
          {onPrev || onNext ? (
            <div className="flex justify-between">
              <Button type="button" variant="ghost" size="sm" onClick={onPrev} disabled={!onPrev || !canPrev}>
                <ChevronLeft className="size-4" /> Prev
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={onNext} disabled={!onNext}>
                Next <ChevronRight className="size-4" />
              </Button>
            </div>
          ) : null}
        </div>
      </aside>
    </div>
  );
}
