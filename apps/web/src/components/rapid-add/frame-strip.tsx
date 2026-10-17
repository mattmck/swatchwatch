"use client";

import { AlertCircle, CheckCircle2, Loader2, RotateCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CaptureFrameEntry } from "@/lib/rapid-add-flow";
import { cn } from "@/lib/utils";

export interface FrameStripProps {
  frames: readonly CaptureFrameEntry[];
  onRetry: (localId: string) => void;
  onRemove: (localId: string) => void;
}

/** Thumbnails of this scan's frames with per-frame upload state and retry. */
export function FrameStrip({ frames, onRetry, onRemove }: FrameStripProps) {
  if (frames.length === 0) return null;
  return (
    <ul className="grid grid-cols-3 gap-2 sm:grid-cols-6" aria-label="Captured frames">
      {frames.map((frame) => (
        <li
          key={frame.localId}
          className={cn(
            "relative overflow-hidden rounded-lg border",
            frame.status === "failed" ? "border-destructive" : "border-border/60",
          )}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- local data URL preview */}
          <img src={frame.dataUrl} alt={`${frame.frameType} frame`} className="aspect-square w-full object-cover" />
          <span className="absolute left-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium uppercase text-white">
            {frame.frameType}
          </span>
          <span className="absolute right-1 top-1 rounded-full bg-background/90 p-0.5">
            {frame.status === "uploading" && (
              <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label="Uploading" />
            )}
            {frame.status === "uploaded" && (
              <CheckCircle2 className="size-4 text-emerald-600" aria-label="Uploaded" />
            )}
            {frame.status === "failed" && <AlertCircle className="size-4 text-destructive" aria-label="Upload failed" />}
          </span>
          {frame.status === "failed" && (
            <div className="absolute inset-x-0 bottom-0 flex gap-1 bg-background/95 p-1">
              <Button
                type="button"
                size="xs"
                variant="outline"
                className="flex-1"
                onClick={() => onRetry(frame.localId)}
                title={frame.error}
              >
                <RotateCw aria-hidden /> Retry
              </Button>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                onClick={() => onRemove(frame.localId)}
                aria-label="Remove frame"
              >
                <X aria-hidden />
              </Button>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
