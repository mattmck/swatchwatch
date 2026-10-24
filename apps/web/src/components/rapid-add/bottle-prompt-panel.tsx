"use client";

import { BOTTLE_SURFACES, type BottleCameraView, type BottleSurface } from "swatchwatch-shared";
import { ToggleChip } from "@/components/toggle-chip";
import { Button } from "@/components/ui/button";
import { surfaceChipStatus } from "@/lib/bottle-rapid-add";

const SURFACE_LABEL: Record<BottleSurface, string> = {
  front: "Front",
  bottom: "Bottom",
  glass: "Glass",
  box: "Box",
};

export interface BottlePromptPanelProps {
  /** What to photograph now; `null` once the server asked for nothing more. */
  view: BottleCameraView | null;
  captured: readonly BottleSurface[];
  skipped: readonly BottleSurface[];
  /** Skipping is in flight, or a frame is still uploading. */
  disabled: boolean;
  onSelectSurface: (surface: BottleSurface) => void;
  onSkip: () => void;
}

/** The guided bottle sequence's prompt: the current surface, its hint, step n of m, surface chips and "Can't see it". */
export function BottlePromptPanel({ view, captured, skipped, disabled, onSelectSurface, onSkip }: BottlePromptPanelProps) {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/40 p-3" aria-live="polite">
      {view ? (
        <div className="space-y-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-medium">
              {view.prompt}
              {view.optional && <span className="ml-1 text-sm text-muted-foreground">(optional)</span>}
            </p>
            <Button type="button" variant="outline" size="sm" onClick={onSkip} disabled={disabled}>
              Can&apos;t see it
            </Button>
          </div>
          {view.hint && <p className="text-sm text-muted-foreground">{view.hint}</p>}
          <p className="text-xs text-muted-foreground">
            Step {view.step} of {view.total}
          </p>
        </div>
      ) : (
        <p className="font-medium">That&apos;s everything we need. Tap Find match, or pick a surface for another photo.</p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-1.5" role="group" aria-label="Photograph a surface">
        {BOTTLE_SURFACES.map((surface) => {
          const status = surfaceChipStatus(surface, captured, skipped);
          return (
            <ToggleChip
              key={surface}
              pressed={view?.surface === surface}
              onPressedChange={() => onSelectSurface(surface)}
              className="h-7 px-2.5 py-1 text-xs"
            >
              {SURFACE_LABEL[surface]}
              {status === "captured" && <span aria-label="photographed">✓</span>}
              {status === "skipped" && <span className="opacity-70">skipped</span>}
            </ToggleChip>
          );
        })}
      </div>
    </div>
  );
}
