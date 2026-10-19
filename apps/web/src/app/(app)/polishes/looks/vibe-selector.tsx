"use client";

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

/** Occasion, mood and finish chips plus the Owned only switch. */
export function VibeSelector({ vibe, onChange, className }: VibeSelectorProps) {
  return (
    <div className={cn("space-y-4", className)} role="group" aria-label="Your vibe">
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
