"use client";

import { useState } from "react";
import Link from "next/link";
import { Bookmark, BookmarkCheck, Check, Clock, Info, Link2, Paintbrush, Palette, Plus, Repeat, Search, ShoppingBag } from "lucide-react";
import type { Polish } from "swatchwatch-shared";
import { resolveDisplayHex } from "swatchwatch-shared";
import { BuyFromBrandLink } from "@/components/buy-from-brand-link";
import { detailHref } from "@/lib/detail-href";
import { ColorDot } from "@/components/color-dot";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import type { Look, LookDifficulty, LookStep, LookStepRole } from "@/lib/looks";
import { cn } from "@/lib/utils";

const DIFFICULTY_LABELS: Record<LookDifficulty, string> = {
  easy: "Easy",
  medium: "Medium",
  advanced: "Advanced",
};

/** Swatch strip widths: the base dominates, toppers are a sliver. */
const STRIP_GROW: Record<LookStepRole, number> = { base: 3, accent: 2, topper: 1 };

/**
 * A swatch strip for the look's steps, in order (toppers get a sparkle sheen). With `backdrop`
 * (the skin-tone preview) the strip sits on a skin-colored mat; that changes only the mat.
 */
export function LookSwatchStrip({
  steps,
  className,
  backdrop,
}: {
  steps: Pick<LookStep, "role" | "hex">[];
  className?: string;
  backdrop?: string;
}) {
  const strip = (
    <div aria-hidden className={cn("flex h-14 overflow-hidden rounded-xl border border-border shadow-inner", className)}>
      {steps.map((step, index) => (
        <span
          key={`${step.role}-${index}`}
          className="relative block h-full"
          style={{ backgroundColor: step.hex, flexGrow: STRIP_GROW[step.role] }}
        >
          {step.role === "topper" && (
            <span className="absolute inset-0 bg-[radial-gradient(circle_at_30%_30%,rgba(255,255,255,0.8)_0_1.5px,transparent_2px),radial-gradient(circle_at_70%_60%,rgba(255,255,255,0.7)_0_1px,transparent_1.5px)] bg-[length:10px_10px]" />
          )}
        </span>
      ))}
    </div>
  );
  if (!backdrop) return strip;
  return (
    <div aria-hidden className="rounded-2xl p-2.5 transition-colors" style={{ backgroundColor: backdrop }} data-testid="skin-backdrop">
      {strip}
    </div>
  );
}

function OwnershipPill({ step }: { step: LookStep }) {
  if (step.source === "owned") {
    return (
      <Badge className="border-emerald-600/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
        <Check aria-hidden />
        Owned
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="border-brand-purple/40 text-brand-purple">
      <Plus aria-hidden />
      Add
    </Badge>
  );
}

/**
 * "Color Lab" (#386): opens color search seeded with a look's palette (the plan's
 * "Advanced / Color Lab"); the search page's "Back to Looks" link returns to the same vibe.
 */
export function ColorLabLink({
  href,
  onClick,
  lookName,
  className,
}: {
  href: string;
  onClick?: () => void;
  lookName: string;
  className?: string;
}) {
  return (
    <Button asChild variant="ghost" size="sm" className={className}>
      <Link href={href} onClick={onClick} aria-label={`Open ${lookName} in Color Lab`} title="Explore this palette in color search">
        <Palette className="size-4" aria-hidden />
        Color Lab
      </Link>
    </Button>
  );
}

function searchHrefForHex(hex: string): string {
  return `/polishes/search?${new URLSearchParams({ color: hex.replace("#", ""), harmony: "similar" })}`;
}

interface StepRowProps {
  step: LookStep;
  /** Where the polish detail page's back link returns to (this page with its vibe + seed). */
  returnTo: string;
  onSwap: (polish: Polish) => void;
}

function StepRow({ step, returnTo, onSwap }: StepRowProps) {
  const [swapOpen, setSwapOpen] = useState(false);
  const polish = step.polish;

  return (
    <li className="py-2.5">
      <div className="flex items-center gap-3">
        <ColorDot hex={step.hex} size="lg" className="shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{step.label}</p>
          {polish ? (
            <>
              <Link href={detailHref(polish.id, returnTo)} className="block truncate text-sm font-medium hover:underline">
                {polish.name}
              </Link>
              <p className="truncate text-xs text-muted-foreground">{polish.brand}</p>
            </>
          ) : (
            <Link
              href={searchHrefForHex(step.targetHex)}
              className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-primary hover:underline"
            >
              <Search className="size-3.5" aria-hidden />
              Find a shade like this
            </Link>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <OwnershipPill step={step} />
          {step.alternatives.length > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs pointer-coarse:h-9"
              aria-expanded={swapOpen}
              onClick={() => setSwapOpen((open) => !open)}
            >
              <Repeat className="size-3.5" aria-hidden />
              Swap
            </Button>
          )}
        </div>
      </div>
      {step.source === "catalog" && polish?.buyUrl && (
        <div className="mt-1 pl-11">
          <BuyFromBrandLink url={polish.buyUrl} brand={polish.brand} name={polish.name} />
        </div>
      )}
      {swapOpen && step.alternatives.length > 0 && (
        <ul className="mt-2 space-y-1 rounded-lg border border-dashed border-border p-2" aria-label={`Swap ${step.label}`}>
          {step.alternatives.map((alt) => (
            <li key={alt.id}>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
                onClick={() => {
                  onSwap(alt);
                  setSwapOpen(false);
                }}
              >
                <ColorDot hex={resolveDisplayHex(alt)} size="sm" />
                <span className="min-w-0 flex-1 truncate">
                  {alt.name} <span className="text-muted-foreground">· {alt.brand}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

interface LookCardProps {
  look: Look;
  /** `returnTo` for polish detail links, so Back returns to the same vibe and seed. */
  returnTo: string;
  saved: boolean;
  onWear: () => void;
  onSave: () => void;
  onSwap: (role: LookStepRole, polish: Polish) => void;
  /** Open the "Add missing items" shopping list. */
  onShop: () => void;
  /** Open the detail drawer. */
  onDetails: () => void;
  /** Copy the look as text + link. */
  onShare: () => void;
  /** `/polishes/search` seeded with this look's palette (`lookColorLabHref`, #386). */
  colorLabHref: string;
  /** Called when the Color Lab link is followed (telemetry). */
  onColorLab: () => void;
  /** Skin-tone preview mat color behind the swatch strip (cosmetic). */
  backdrop?: string;
}

/** One look: swatch strip, steps with ownership pills and Swap, difficulty/time, Wear this and Save. */
export function LookCard({
  look,
  returnTo,
  saved,
  onWear,
  onSave,
  onSwap,
  onShop,
  onDetails,
  onShare,
  colorLabHref,
  onColorLab,
  backdrop,
}: LookCardProps) {
  const canWear = look.ownedSteps > 0;
  return (
    <Card className="flex flex-col gap-4">
      <CardHeader className="gap-1">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-lg">{look.name}</CardTitle>
          <Badge variant="secondary" className="font-normal">
            <Clock aria-hidden />
            {DIFFICULTY_LABELS[look.difficulty]} · {look.minutes} min
          </Badge>
        </div>
        <CardDescription>{look.description}</CardDescription>
      </CardHeader>
      <CardContent className="flex-1 space-y-2">
        <LookSwatchStrip steps={look.steps} backdrop={backdrop} />
        <ul className="divide-y divide-border">
          {look.steps.map((step) => (
            <StepRow key={step.role} step={step} returnTo={returnTo} onSwap={(polish) => onSwap(step.role, polish)} />
          ))}
        </ul>
        {look.missingSteps > 0 && (
          <p className="text-xs text-muted-foreground">
            {look.ownedSteps === 0
              ? "You'd need every polish for this one."
              : `Add ${look.missingSteps} polish${look.missingSteps === 1 ? "" : "es"} to finish this look.`}
          </p>
        )}
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2">
        <Button
          type="button"
          className="flex-1"
          onClick={onWear}
          disabled={!canWear}
          title={canWear ? undefined : "You don't own any polish in this look yet"}
        >
          <Paintbrush className="size-4" aria-hidden />
          Wear this
        </Button>
        <Button type="button" variant="outline" onClick={onSave} aria-pressed={saved}>
          {saved ? <BookmarkCheck className="size-4" aria-hidden /> : <Bookmark className="size-4" aria-hidden />}
          {saved ? "Saved" : "Save"}
        </Button>
        {look.missingSteps > 0 && (
          <Button type="button" variant="secondary" className="w-full" onClick={onShop}>
            <ShoppingBag className="size-4" aria-hidden />
            Add missing items ({look.missingSteps})
          </Button>
        )}
        <Button type="button" variant="ghost" size="sm" className="flex-1" onClick={onDetails}>
          <Info className="size-4" aria-hidden />
          Details
        </Button>
        <Button type="button" variant="ghost" size="sm" className="flex-1" onClick={onShare}>
          <Link2 className="size-4" aria-hidden />
          Copy look
        </Button>
        <ColorLabLink href={colorLabHref} onClick={onColorLab} lookName={look.name} className="flex-1" />
      </CardFooter>
    </Card>
  );
}
