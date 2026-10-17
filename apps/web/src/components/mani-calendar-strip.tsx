"use client";

import { cn } from "@/lib/utils";
import type { CalendarDay } from "@/lib/mani-log";

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

interface ManiCalendarStripProps {
  weeks: CalendarDay[][];
  selectedDate: string | null;
  onSelectDay: (day: CalendarDay) => void;
}

/**
 * Recent weeks of the mani log as a Monday-first grid (issue #269). Each day shows up to three
 * swatch dots for the polishes worn; days with a mani are highlighted. Future days are inert.
 */
export function ManiCalendarStrip({ weeks, selectedDate, onSelectDay }: ManiCalendarStripProps) {
  return (
    <div className="space-y-1.5" role="group" aria-label="Mani calendar, recent weeks">
      <div className="grid grid-cols-7 gap-1.5">
        {WEEKDAY_LABELS.map((label) => (
          <div key={label} aria-hidden className="text-center text-[11px] font-medium text-muted-foreground">
            {label}
          </div>
        ))}
      </div>
      {weeks.map((week) => (
        <div key={week[0].date} className="grid grid-cols-7 gap-1.5">
          {week.map((day) => {
            const worn = day.manicures.length > 0;
            const selected = selectedDate === day.date;
            const dayNumber = Number(day.date.slice(8, 10));
            const label = `${day.date}: ${
              worn ? `${day.manicures.length} mani${day.manicures.length > 1 ? "s" : ""}` : "no mani"
            }`;
            return (
              <button
                key={day.date}
                type="button"
                aria-label={label}
                aria-pressed={selected}
                aria-current={day.isToday ? "date" : undefined}
                disabled={day.isFuture}
                onClick={() => onSelectDay(day)}
                className={cn(
                  "flex h-12 flex-col items-center justify-between rounded-lg border px-1 py-1 text-xs transition-colors",
                  "disabled:cursor-default disabled:opacity-40",
                  worn
                    ? "border-brand-purple/25 bg-brand-pink-light/40 dark:bg-brand-purple/25"
                    : "border-border/60 hover:bg-muted/50",
                  day.isToday && "ring-2 ring-brand-purple/50",
                  selected && "border-brand-purple bg-brand-pink-light/80 dark:bg-brand-purple/45"
                )}
              >
                <span className={cn("leading-none", worn ? "font-semibold" : "text-muted-foreground")}>
                  {dayNumber === 1 ? day.date.slice(5, 7) + "/1" : dayNumber}
                </span>
                <span className="flex h-3 items-center gap-0.5" aria-hidden>
                  {day.hexes.slice(0, 3).map((hex) => (
                    <span
                      key={hex}
                      className="inline-block size-2.5 rounded-full border border-black/10"
                      style={{ backgroundColor: hex }}
                    />
                  ))}
                  {worn && day.hexes.length === 0 && (
                    <span className="inline-block size-2.5 rounded-full bg-brand-purple/50" />
                  )}
                </span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
