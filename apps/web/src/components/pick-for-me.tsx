"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Dices, Loader2, Palette, Shuffle } from "lucide-react";
import type { ManicureWearStat, Polish } from "swatchwatch-shared";
import { resolveDisplayHex } from "swatchwatch-shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ColorDot } from "@/components/color-dot";
import { EmptyState } from "@/components/empty-state";
import { FinishBadges } from "@/components/finish-badges";
import { LogManiButton } from "@/components/log-mani-button";
import { useReferenceData } from "@/hooks/use-reference-data";
import { listAllPolishes } from "@/lib/api";
import { getHarmonyTypeOptions } from "@/lib/color-harmonies";
import { isOwnedPolish } from "@/lib/inventory-status";
import {
  pickForMe,
  pushPickHistory,
  suggestPairings,
  type PairSuggestion,
  type PickResult,
} from "@/lib/pick-for-me";
import { trackEvent } from "@/lib/telemetry";
import { detailHref } from "@/lib/detail-href";

/** Where the pick UI is shown; sent with every telemetry event. */
type PickSource = "dashboard" | "polishes";

interface PickState {
  result: PickResult | null;
  history: string[];
  /** Increments on every draw so a re-roll that lands on the same polish still counts. */
  draw: number;
  rerolled: boolean;
}

function draw(polishes: Polish[], history: string[], draw: number, rerolled: boolean): PickState {
  const result = pickForMe(polishes, { now: Date.now(), random: Math.random, exclude: history });
  return {
    result,
    history: result ? pushPickHistory(history, result.polish.id) : history,
    draw,
    rerolled,
  };
}

/** Apply wear stats returned by a mani log so the next pick sees the new `lastWornAt`. */
function applyWearStats(polishes: Polish[], stats: ManicureWearStat[]): Polish[] {
  const byShade = new Map(stats.map((stat) => [stat.shadeId, stat]));
  return polishes.map((polish) => {
    const stat = byShade.get(polish.id);
    return stat
      ? { ...polish, wearCount: stat.wearCount, lastWornAt: stat.lastWornAt, triedAt: stat.triedAt }
      : polish;
  });
}

interface PickForMePanelProps {
  /** The user's polishes; only `owned` ones are candidates. */
  polishes: Polish[];
  source: PickSource;
}

/**
 * The pick itself (issue #272): swatch, name, brand, finish and the reasons it was chosen, with
 * Pick again (never repeats the last 3 picks), Pair it, and one-tap "Log today's mani" that
 * includes any shown pairings. Shows an empty state when the user owns nothing.
 */
export function PickForMePanel({ polishes: initialPolishes, source }: PickForMePanelProps) {
  const { finishTypes, harmonyTypes } = useReferenceData();
  const [polishes, setPolishes] = useState<Polish[]>(() => initialPolishes.filter(isOwnedPolish));
  const [state, setState] = useState<PickState>(() => draw(polishes, [], 1, false));
  const [pairings, setPairings] = useState<PairSuggestion[] | null>(null);

  const pick = state.result;
  const pickId = pick?.polish.id;
  const reasonKinds = pick?.reasons.map((r) => r.kind).join(",");
  const poolSize = pick?.poolSize;

  useEffect(() => {
    if (!pickId) return;
    trackEvent(state.rerolled ? "pick_for_me_rerolled" : "pick_for_me_shown", {
      source,
      reasons: reasonKinds,
      poolSize,
      draw: state.draw,
    });
  }, [pickId, reasonKinds, poolSize, source, state.draw, state.rerolled]);

  const harmonyLabels = useMemo(
    () => new Map(getHarmonyTypeOptions(harmonyTypes).map((option) => [option.value as string, option.label])),
    [harmonyTypes]
  );

  if (!pick) {
    return (
      <EmptyState
        title="Nothing to pick from yet"
        description="Add polishes you own to your collection and we'll pick one for you to wear."
        actionLabel="+ Add Polish"
        actionHref="/polishes/new"
        className="min-h-[220px] py-4"
      />
    );
  }

  const polish = pick.polish;
  const hex = resolveDisplayHex(polish);
  const companions = (pairings ?? []).map((p) => ({ id: p.polish.id, role: p.role }));

  function pickAgain() {
    setPairings(null);
    setState((current) => draw(polishes, current.history, current.draw + 1, true));
  }

  function pairIt() {
    if (!pick) return;
    const suggestions = suggestPairings(pick.polish, polishes);
    setPairings(suggestions);
    trackEvent("pick_for_me_paired", { source, pairings: suggestions.length });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-4">
        <span
          aria-hidden
          className="size-16 shrink-0 rounded-2xl border border-border shadow-inner"
          style={{ backgroundColor: hex ?? "#ccc" }}
        />
        <div className="min-w-0 flex-1" aria-live="polite" aria-atomic="true">
          <p className="sr-only">Your pick:</p>
          <Link
            href={detailHref(polish.id)}
            className="block truncate text-lg font-semibold hover:underline"
          >
            {polish.name}
          </Link>
          <p className="truncate text-sm text-muted-foreground">{polish.brand}</p>
          <FinishBadges polish={polish} finishTypes={finishTypes} max={3} className="mt-1" />
          <p className="sr-only">Why: {pick.reasons.map((r) => r.label).join(", ")}.</p>
          <ul className="mt-2 flex flex-wrap gap-1.5" aria-hidden>
            {pick.reasons.map((reason) => (
              <li key={reason.kind}>
                <Badge variant="outline" className="border-brand-purple/30 text-xs font-normal">
                  {reason.label}
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {pairings !== null && (
        <section aria-label="Pairings" className="rounded-lg border border-dashed border-brand-purple/30 p-3">
          {pairings.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No close harmony in your collection for this one. Try it solo, or pick again.
            </p>
          ) : (
            <ul className="space-y-2">
              {pairings.map((pairing) => (
                <li key={`${pairing.polish.id}:${pairing.harmony}`} className="flex items-center gap-3">
                  <ColorDot hex={resolveDisplayHex(pairing.polish)} size="md" />
                  <div className="min-w-0 flex-1">
                    <Link
                      href={detailHref(pairing.polish.id)}
                      className="block truncate text-sm font-medium hover:underline"
                    >
                      {pairing.polish.name}
                    </Link>
                    <p className="truncate text-xs text-muted-foreground">{pairing.polish.brand}</p>
                  </div>
                  <Badge variant="secondary" className="shrink-0 text-xs font-normal">
                    {pairing.harmony === "topper"
                      ? pairing.label
                      : `${harmonyLabels.get(pairing.harmony) ?? pairing.harmony} accent`}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" onClick={pickAgain} disabled={polishes.length <= 1}>
          <Shuffle className="size-4" aria-hidden />
          Pick again
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={pairIt} aria-pressed={pairings !== null}>
          <Palette className="size-4" aria-hidden />
          Pair it
        </Button>
        <LogManiButton
          // Remount per pick/pairing so the label and request always match what's shown.
          key={`${polish.id}:${companions.map((c) => c.id).join(",")}`}
          polish={polish}
          companions={companions}
          onLogged={() => trackEvent("pick_for_me_logged", { source, pairings: companions.length })}
          onWearStatsChange={(stats) => setPolishes((current) => applyWearStats(current, stats))}
        />
      </div>
    </div>
  );
}

const CARD_ACCENT =
  "absolute inset-y-0 left-0 w-1 bg-gradient-to-b from-brand-pink-soft via-brand-lilac to-brand-purple";

/** Dashboard "Pick for me" card; `polishes` is the owned list the dashboard already loaded. */
export function PickForMeCard({ polishes }: { polishes: Polish[] }) {
  return (
    <Card className="relative overflow-hidden">
      <span aria-hidden className={CARD_ACCENT} />
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Dices className="size-5 text-brand-purple" aria-hidden />
          Pick for me
        </CardTitle>
        <CardDescription>Can&apos;t decide? A random owned polish, favoring untried shades, ones you haven&apos;t worn lately, and thin spots in your collection.</CardDescription>
      </CardHeader>
      <CardContent>
        <PickForMePanel polishes={polishes} source="dashboard" />
      </CardContent>
    </Card>
  );
}

/** "Pick for me" button for `/polishes`: opens a dialog that loads the owned list on open. */
export function PickForMeButton({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="outline" className={className} onClick={() => setOpen(true)}>
        <Dices className="size-4" aria-hidden />
        Pick for me
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Pick for me</DialogTitle>
            <DialogDescription>
              A random owned polish, favoring untried shades, ones you haven&apos;t worn lately, and thin spots in
              your collection.
            </DialogDescription>
          </DialogHeader>
          {/* Mounted only while open, so the collection loads on demand. */}
          {open && <OwnedPickLoader />}
        </DialogContent>
      </Dialog>
    </>
  );
}

function OwnedPickLoader() {
  const [owned, setOwned] = useState<Polish[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listAllPolishes({ availability: "owned", sortBy: "createdAt", sortOrder: "desc" })
      .then((rows) => {
        if (!cancelled) setOwned(rows.filter(isOwnedPolish));
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Couldn't load your collection");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {error}
      </p>
    );
  }
  if (!owned) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        Loading your collection…
      </p>
    );
  }
  return <PickForMePanel polishes={owned} source="polishes" />;
}
