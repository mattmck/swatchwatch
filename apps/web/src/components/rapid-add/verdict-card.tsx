"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { CircleCheck, CirclePlus, PackageCheck, ScanBarcode } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ColorDot } from "@/components/color-dot";
import type { CaptureVerdict } from "@/lib/capture-verdict";
import { cn } from "@/lib/utils";

export interface VerdictCardProps {
  verdict: CaptureVerdict;
  /** The owned-verdict quantity bump has been undone. */
  quantityRestored: boolean;
  undoing: boolean;
  onUndoQuantity: () => void;
  onScanNext: () => void;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled verdict: ${JSON.stringify(value)}`);
}

function detailHref(shadeId: string | undefined): string {
  return shadeId ? `/polishes/detail?id=${encodeURIComponent(shadeId)}` : "/polishes";
}

interface VerdictLayout {
  tone: "owned" | "added" | "add";
  icon: ReactNode;
  eyebrow: string;
  title: string;
  body: ReactNode;
  actions: ReactNode;
}

const TONE_CLASSES: Record<VerdictLayout["tone"], string> = {
  owned: "border-amber-400/70 bg-amber-50 dark:bg-amber-950/30",
  added: "border-emerald-400/70 bg-emerald-50 dark:bg-emerald-950/30",
  add: "border-brand-purple/40 bg-brand-pink-light/15 dark:bg-brand-purple/15",
};

/**
 * The in-aisle answer for one scan. The switch is exhaustive: a new `CaptureVerdict`
 * kind (near-dupe #265, wishlist #261) fails type-checking until it gets a layout here.
 */
function layoutFor(props: VerdictCardProps): VerdictLayout {
  const { verdict, quantityRestored, undoing, onUndoQuantity } = props;
  switch (verdict.kind) {
    case "owned":
      return {
        tone: "owned",
        icon: <PackageCheck className="size-7 text-amber-600 dark:text-amber-400" aria-hidden />,
        eyebrow: "Already in your collection",
        title: "You already own this",
        body: quantityRestored ? (
          <p>Got it — you still have {verdict.previousQuantity}.</p>
        ) : (
          <p>
            Rapid Add counted another bottle, so you now have {verdict.quantity}. Only checking? Undo it.
          </p>
        ),
        actions: (
          <>
            {verdict.shadeId && !quantityRestored && (
              <Button type="button" variant="outline" onClick={onUndoQuantity} disabled={undoing}>
                {undoing ? "Undoing…" : "I didn't buy another"}
              </Button>
            )}
            <Button asChild variant="outline">
              <Link href={detailHref(verdict.shadeId)}>View polish</Link>
            </Button>
          </>
        ),
      };
    case "added":
      return {
        tone: "added",
        icon: <CircleCheck className="size-7 text-emerald-600 dark:text-emerald-400" aria-hidden />,
        eyebrow: verdict.priorOwnership === "none" ? "New to your collection" : "Matched",
        title: verdict.priorOwnership === "none" ? "Added to your collection" : "It's in your collection",
        body:
          verdict.priorOwnership === "none" ? (
            <p>You didn&apos;t own this yet, so we added it.</p>
          ) : (
            <p>We matched it and saved it to your collection.</p>
          ),
        actions: (
          <Button asChild variant="outline">
            <Link href={detailHref(verdict.shadeId)}>View polish</Link>
          </Button>
        ),
      };
    case "add":
      return {
        tone: "add",
        icon: <CirclePlus className="size-7 text-brand-purple" aria-hidden />,
        eyebrow: "No match yet",
        title: "Not found — add it",
        body: (
          <p>
            We couldn&apos;t match this to the catalog
            {verdict.evidence.gtin ? ` (barcode ${verdict.evidence.gtin})` : ""}. Add it by hand, or
            scan again with a clear photo of the label.
          </p>
        ),
        actions: (
          <Button asChild variant="outline">
            <Link href="/polishes/new">Add manually</Link>
          </Button>
        ),
      };
    default:
      return assertNever(verdict);
  }
}

export function VerdictCard(props: VerdictCardProps) {
  const layout = layoutFor(props);
  const display = props.verdict.display;
  const hex = props.verdict.kind === "owned" ? props.verdict.hex : undefined;

  return (
    <section
      aria-live="polite"
      aria-labelledby="rapid-add-verdict-title"
      className={cn("space-y-4 rounded-xl border-2 p-5", TONE_CLASSES[layout.tone])}
    >
      <div className="flex items-start gap-3">
        {layout.icon}
        <div className="min-w-0 space-y-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {layout.eyebrow}
          </p>
          <h2 id="rapid-add-verdict-title" className="text-xl font-bold leading-tight">
            {layout.title}
          </h2>
          {display && (
            <p className="flex items-center gap-2 truncate text-sm font-medium">
              {hex && <ColorDot hex={hex} size="sm" />}
              <span className="truncate">{display}</span>
            </p>
          )}
        </div>
      </div>
      <div className="text-sm text-muted-foreground">{layout.body}</div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="brand" onClick={props.onScanNext}>
          <ScanBarcode aria-hidden /> Scan next
        </Button>
        {layout.actions}
      </div>
    </section>
  );
}
