"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import Link from "next/link";
import type { Polish } from "swatchwatch-shared";
import { resolveDisplayHex } from "swatchwatch-shared";
import type { LucideIcon } from "lucide-react";
import { Check, ChevronRight, FileSpreadsheet, ScanBarcode, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { trackOnboardingStepClicked } from "@/lib/metrics-events";
import {
  GETTING_STARTED_STEPS,
  ONBOARDING_GOAL,
  dismissGettingStarted,
  gettingStartedStorageKey,
  gettingStartedView,
  markGettingStartedStarted,
  markStepVisited,
  onboardingProgress,
  parseGettingStartedState,
  serializeGettingStartedState,
  type GettingStartedState,
  type GettingStartedStepId,
} from "@/lib/onboarding";

export const GETTING_STARTED_STEP_COPY: Record<
  GettingStartedStepId,
  { title: string; description: string; icon: LucideIcon }
> = {
  import: {
    title: "Import a spreadsheet",
    description: "Bring a CSV from Google Sheets, Notion or another polish app.",
    icon: FileSpreadsheet,
  },
  scan: {
    title: "Scan a bottle",
    description: "Point your camera at the barcode or label.",
    icon: ScanBarcode,
  },
  search: {
    title: "Search the catalog",
    description: "Find shades by brand or name and add them in a tap.",
    icon: Search,
  },
};

// localStorage as an external store: no setState-in-effect, and the static prerender renders
// nothing (server snapshot) so it never flashes for users who closed it.
const SERVER_SNAPSHOT = "\u0000server";
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, state: GettingStartedState) {
  try {
    window.localStorage.setItem(key, serializeGettingStartedState(state));
  } catch {
    // Private mode or blocked storage: the checklist just shows again next visit.
  }
  listeners.forEach((listener) => listener());
}

interface GettingStartedProps {
  /** The user's owned polishes (the strip fills with their colors, oldest first). */
  ownedPolishes: Polish[];
  /** Internal user id, so a shared browser keeps each user's choice. */
  userId: string | null;
  className?: string;
}

/**
 * First-run checklist on the dashboard: three ways to add polishes (fastest first) and a
 * 20-swatch strip that fills with the user's own colors. Logic and visibility rules live in
 * `lib/onboarding.ts`.
 */
export function GettingStarted({ ownedPolishes, userId, className }: GettingStartedProps) {
  const storageKey = gettingStartedStorageKey(userId);
  const raw = useSyncExternalStore(
    subscribe,
    () => readStorage(storageKey),
    () => SERVER_SNAPSHOT
  );
  const isServer = raw === SERVER_SNAPSHOT;
  const state = parseGettingStartedState(isServer ? null : raw);
  const ownedCount = ownedPolishes.length;
  const view = isServer ? "hidden" : gettingStartedView(ownedCount, state);

  useEffect(() => {
    if (isServer) return;
    const current = parseGettingStartedState(raw);
    const next = markGettingStartedStarted(current, ownedCount);
    if (next !== current) writeStorage(storageKey, next);
  }, [isServer, raw, ownedCount, storageKey]);

  const update = useCallback(
    (change: (s: GettingStartedState) => GettingStartedState) => {
      writeStorage(storageKey, change(parseGettingStartedState(readStorage(storageKey))));
    },
    [storageKey]
  );

  if (view === "hidden") return null;

  const progress = onboardingProgress(ownedCount);
  const complete = view === "complete";

  return (
    <Card
      aria-labelledby="getting-started-heading"
      className={cn(
        "relative gap-0 overflow-hidden border border-brand-purple/25 py-0 shadow-[0_20px_45px_rgba(66,16,126,0.12)]",
        className
      )}
    >
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-1 bg-gradient-to-b from-brand-pink-soft via-brand-lilac to-brand-purple"
      />
      <div className="relative space-y-5 px-5 py-5 sm:px-6">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="getting-started-heading" className="text-lg font-semibold leading-snug">
              {complete ? "Your collection is set up" : "Build your collection"}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {complete
                ? "Stats, the gap map and Pick for me now have enough to work with."
                : `Add your first ${ONBOARDING_GOAL} polishes and the rest of SwatchWatch comes alive. Pick whichever way is fastest for you.`}
            </p>
          </div>
          {!complete && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="-mr-2 -mt-1 shrink-0 text-muted-foreground"
              aria-label="Close getting started"
              onClick={() => update(dismissGettingStarted)}
            >
              <X className="size-4" aria-hidden="true" />
            </Button>
          )}
        </div>

        <SwatchStrip polishes={ownedPolishes} label={progress.label} count={progress.count} />

        {complete ? (
          <Button type="button" onClick={() => update(dismissGettingStarted)}>
            Done
          </Button>
        ) : (
          <ul className="divide-y divide-border/70 overflow-hidden rounded-xl border border-border/80">
            {GETTING_STARTED_STEPS.map((step) => {
              const copy = GETTING_STARTED_STEP_COPY[step.id];
              const visited = state.visited.includes(step.id);
              return (
                <li key={step.id}>
                  <Link
                    href={step.href}
                    onClick={() => {
                      trackOnboardingStepClicked({ step: step.id, surface: "dashboard_checklist", ownedCount });
                      update((s) => markStepVisited(s, step.id));
                    }}
                    className="group flex min-h-16 items-center gap-3 px-3 py-3 transition-colors hover:bg-brand-pink-light/25 focus-visible:bg-brand-pink-light/25 focus-visible:outline-none sm:px-4 dark:hover:bg-brand-purple/15 dark:focus-visible:bg-brand-purple/15"
                  >
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-gradient-brand-soft text-brand-purple-deep dark:text-white">
                      <copy.icon className="size-5" aria-hidden="true" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">{copy.title}</span>
                      <span className="block text-sm text-muted-foreground">{copy.description}</span>
                    </span>
                    {visited ? (
                      <Check className="size-4 shrink-0 text-brand-purple dark:text-brand-lilac" aria-label="Opened before" />
                    ) : (
                      <ChevronRight
                        className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none"
                        aria-hidden="true"
                      />
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Card>
  );
}

/**
 * Progress as 20 nail-shaped swatches: each owned polish paints one in its own color, oldest
 * first; the rest are empty outlines.
 */
function SwatchStrip({ polishes, label, count }: { polishes: Polish[]; label: string; count: number }) {
  const hexes = [...polishes]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(0, ONBOARDING_GOAL)
    .map((polish) => resolveDisplayHex(polish));

  return (
    <div className="space-y-2">
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={ONBOARDING_GOAL}
        aria-valuenow={count}
        aria-valuetext={label}
        aria-label="Polishes added"
        className="grid max-w-[18rem] grid-cols-10 gap-1.5 sm:max-w-xl sm:grid-cols-[repeat(20,minmax(0,1fr))]"
      >
        {Array.from({ length: ONBOARDING_GOAL }, (_, i) => {
          const filled = i < count;
          const hex = hexes[i];
          return (
            <span
              key={i}
              aria-hidden
              className={cn(
                "aspect-[3/4] rounded-t-full rounded-b-[3px]",
                filled
                  ? "shadow-[inset_0_-2px_0_rgba(0,0,0,0.18),inset_0_1px_0_rgba(255,255,255,0.35)] ring-1 ring-inset ring-black/10 dark:ring-white/20"
                  : "border border-dashed border-brand-purple/45 dark:border-brand-lilac/30"
              )}
              style={filled ? { backgroundColor: hex ?? "var(--brand-lilac)" } : undefined}
            />
          );
        })}
      </div>
      <p className="text-sm font-medium tabular-nums text-brand-purple-deep dark:text-brand-lilac">{label}</p>
    </div>
  );
}

