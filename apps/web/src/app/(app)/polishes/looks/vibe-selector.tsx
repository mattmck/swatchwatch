"use client";

import { useState } from "react";
import { ChevronDown, SlidersHorizontal } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { ToggleChip } from "@/components/toggle-chip";
import {
  LOOK_FINISHES,
  LOOK_FINISH_LABELS,
  LOOK_MOODS,
  LOOK_MOOD_LABELS,
  LOOK_OCCASIONS,
  LOOK_OCCASION_LABELS,
  type Vibe,
} from "@/lib/looks";
import { cn } from "@/lib/utils";

interface ChipRowProps<T extends string> {
  label: string;
  options: readonly T[];
  labels: Record<T, string>;
  value: T | null;
  onChange: (value: T) => void;
  /** Label for a leading "no preference" chip (selected when `value` is null). */
  anyLabel?: string;
  onAny?: () => void;
}

/**
 * One labeled row of chips. Below `lg` the row scrolls horizontally inside itself (never the
 * page) so the whole vibe fits above the cards on a phone; on `lg` it wraps in the left rail.
 */
function ChipRow<T extends string>({ label, options, labels, value, onChange, anyLabel, onAny }: ChipRowProps<T>) {
  return (
    <fieldset className="min-w-0">
      <legend className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</legend>
      <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none] lg:mx-0 lg:flex-wrap lg:overflow-visible lg:px-0">
        {anyLabel && onAny && (
          <ToggleChip pressed={value === null} onPressedChange={() => onAny()} className="shrink-0 rounded-full border border-border">
            {anyLabel}
          </ToggleChip>
        )}
        {options.map((option) => (
          <ToggleChip
            key={option}
            pressed={value === option}
            onPressedChange={() => onChange(option)}
            className="shrink-0 rounded-full border border-border"
          >
            {labels[option]}
          </ToggleChip>
        ))}
      </div>
    </fieldset>
  );
}

interface VibeSelectorProps {
  vibe: Vibe;
  onChange: (vibe: Vibe) => void;
  className?: string;
}

/**
 * Occasion, mood and finish chips plus the Owned only switch. Below `lg` the controls collapse
 * into a one-line summary of the current vibe (tap to change), so the looks sit above the fold
 * on a phone; on `lg` they are always open in the left rail.
 */
export function VibeSelector({ vibe, onChange, className }: VibeSelectorProps) {
  const [open, setOpen] = useState(false);
  const summary = [
    LOOK_OCCASION_LABELS[vibe.occasion],
    LOOK_MOOD_LABELS[vibe.mood],
    vibe.finish ? LOOK_FINISH_LABELS[vibe.finish] : "Any finish",
    ...(vibe.ownedOnly ? ["Owned only"] : []),
  ];
  return (
    <div className={className}>
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-lg border border-border px-3 py-2 text-left text-sm lg:hidden"
        aria-expanded={open}
        aria-controls="looks-vibe-controls"
        onClick={() => setOpen((current) => !current)}
      >
        <SlidersHorizontal className="size-4 shrink-0 text-brand-purple" aria-hidden />
        <span className="flex min-w-0 flex-1 flex-wrap gap-1">
          <span className="sr-only">Your vibe: </span>
          {summary.map((label) => (
            <span key={label} className="rounded-full bg-primary/15 px-2 py-0.5 text-xs font-medium">
              {label}
            </span>
          ))}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">{open ? "Done" : "Change"}</span>
        <ChevronDown className={cn("size-4 shrink-0 transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      <VibeControls id="looks-vibe-controls" vibe={vibe} onChange={onChange} className={cn("mt-4 lg:mt-0 lg:block", !open && "hidden")} />
    </div>
  );
}

function VibeControls({ id, vibe, onChange, className }: VibeSelectorProps & { id: string }) {
  return (
    <div id={id} className={cn("space-y-4", className)} role="group" aria-label="Your vibe">
      <ChipRow
        label="Occasion"
        options={LOOK_OCCASIONS}
        labels={LOOK_OCCASION_LABELS}
        value={vibe.occasion}
        onChange={(occasion) => onChange({ ...vibe, occasion })}
      />
      <ChipRow
        label="Mood"
        options={LOOK_MOODS}
        labels={LOOK_MOOD_LABELS}
        value={vibe.mood}
        onChange={(mood) => onChange({ ...vibe, mood })}
      />
      <ChipRow
        label="Finish"
        options={LOOK_FINISHES}
        labels={LOOK_FINISH_LABELS}
        value={vibe.finish}
        onChange={(finish) => onChange({ ...vibe, finish: vibe.finish === finish ? null : finish })}
        anyLabel="Any"
        onAny={() => onChange({ ...vibe, finish: null })}
      />
      <label className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-sm">
        <span>
          <span className="font-medium">Owned only</span>
          <span className="block text-xs text-muted-foreground">Only looks you can do right now</span>
        </span>
        <Switch checked={vibe.ownedOnly} onCheckedChange={(ownedOnly) => onChange({ ...vibe, ownedOnly })} />
      </label>
    </div>
  );
}
