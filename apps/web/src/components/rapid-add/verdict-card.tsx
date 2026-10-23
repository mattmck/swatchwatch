"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Camera, CircleCheck, CirclePlus, Copy, Heart, PackageCheck, ScanBarcode, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ColorDot } from "@/components/color-dot";
import { Badge } from "@/components/ui/badge";
import { useReferenceData } from "@/hooks/use-reference-data";
import { resolveFinishLabel } from "@/lib/finish-options";
import { DUPE_GRADE_META, FINISH_COMPATIBILITY_LABELS, dupeCalloutText, dupeHref } from "@/lib/dupes";
import { NEAR_DUPE_CARD_MAX, manualAddHref, type CaptureVerdict, type NearDupeVerdict } from "@/lib/capture-verdict";
import type { RapidAddBusy } from "@/lib/rapid-add-flow";
import { cn } from "@/lib/utils";
import { detailHref } from "@/lib/detail-href";

export interface VerdictCardProps {
  verdict: CaptureVerdict;
  /** The owned-verdict quantity bump has been undone. */
  quantityRestored: boolean;
  undoing: boolean;
  /** Current page activity, to disable the buttons it affects. */
  busy?: RapidAddBusy | null;
  onUndoQuantity: () => void;
  /** Checked match: add it to the collection (finalize). */
  onAddToCollection?: () => void;
  /** Checked match not owned: put it on the wishlist. */
  onAddToWishlist?: (verdict: CaptureVerdict) => void;
  /** Near-dupe verdict: the user followed the link to one of their dupes (counts as cancel). */
  onNearDupeLink?: (verdict: NearDupeVerdict) => void;
  /** Unknown barcode: continue the same scan with a label photo. */
  onPhotographLabel?: () => void;
  onScanNext: () => void;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled verdict: ${JSON.stringify(value)}`);
}

function verdictDetailHref(shadeId: string | undefined): string {
  return shadeId ? detailHref(shadeId) : "/polishes";
}

interface VerdictLayout {
  tone: "owned" | "added" | "add" | "wishlist" | "dupe";
  /** Label of the "scan next" button; a near-dupe verdict calls it Cancel. */
  scanNextLabel?: string;
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
  wishlist: "border-rose-300/70 bg-rose-50 dark:bg-rose-950/30",
  dupe: "border-orange-400/70 bg-orange-50 dark:bg-orange-950/30",
};

/** Owned near-dupes of the scanned shade as swatch pairs with grade and finish compatibility. */
function NearDupeList({ verdict, onLink }: { verdict: NearDupeVerdict; onLink?: (verdict: NearDupeVerdict) => void }) {
  const { finishTypes } = useReferenceData();
  const shown = verdict.dupes.dupes.slice(0, NEAR_DUPE_CARD_MAX);
  const targetHex = verdict.dupes.target.displayHex ?? verdict.hex;
  return (
    <div className="space-y-2">
      <p>
        {dupeCalloutText(verdict.dupes) ?? "You own something similar"}. Add it anyway, or save it to your
        wishlist instead.
      </p>
      <ul className="space-y-2" aria-label="Owned dupes">
        {shown.map((dupe) => {
          const finishes = dupe.finishes.map((finish) => resolveFinishLabel(finish, finishTypes)).join(", ");
          return (
            <li key={dupe.shadeId}>
              <Link
                href={dupeHref(dupe, "/rapid-add")}
                onClick={() => onLink?.(verdict)}
                className="flex items-center gap-3 rounded-lg border bg-background/60 px-3 py-2 text-foreground transition-colors hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
              >
                <span className="flex shrink-0 items-center" aria-hidden>
                  <ColorDot hex={targetHex} size="lg" className="ring-2 ring-white/80" />
                  <ColorDot hex={dupe.displayHex} size="lg" className="-ml-3 ring-2 ring-white/80" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{dupe.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {dupe.brand}
                    {finishes ? ` · ${finishes}` : ""}
                    {" · "}
                    {FINISH_COMPATIBILITY_LABELS[dupe.finishCompatibility]}
                  </span>
                </span>
                <Badge
                  className={`shrink-0 ${DUPE_GRADE_META[dupe.grade].badgeClassName}`}
                  title={DUPE_GRADE_META[dupe.grade].description}
                >
                  {DUPE_GRADE_META[dupe.grade].label}
                </Badge>
              </Link>
            </li>
          );
        })}
      </ul>
      {verdict.dupes.dupeCount > shown.length && (
        <p className="text-xs">
          Showing the closest {shown.length} of {verdict.dupes.dupeCount}.
        </p>
      )}
    </div>
  );
}

/**
 * The in-aisle answer for one scan. The switch is exhaustive: a new `CaptureVerdict`
 * kind (near-dupe #265, wishlist #261) fails type-checking until it gets a layout here.
 */
function layoutFor(props: VerdictCardProps): VerdictLayout {
  const { verdict, quantityRestored, undoing, onUndoQuantity, busy } = props;
  const adding = busy === "finalizing" || busy === "resolving";
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
              <Link href={verdictDetailHref(verdict.shadeId)}>View polish</Link>
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
            <Link href={verdictDetailHref(verdict.shadeId)}>View polish</Link>
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
            <Link href={manualAddHref(verdict.evidence)}>Add manually</Link>
          </Button>
        ),
      };
    case "checked": {
      const viewLink = verdict.shadeId ? (
        <Button asChild variant="outline">
          <Link href={detailHref(verdict.shadeId)}>View polish</Link>
        </Button>
      ) : null;
      const addButton = (label: string) => (
        <Button type="button" variant="outline" onClick={props.onAddToCollection} disabled={adding}>
          {adding ? "Adding…" : label}
        </Button>
      );
      if (verdict.relationship === "owned") {
        const count = verdict.quantity;
        return {
          tone: "owned",
          icon: <PackageCheck className="size-7 text-amber-600 dark:text-amber-400" aria-hidden />,
          eyebrow: "Already in your collection",
          title: "You own this",
          body: (
            <p>
              {typeof count === "number" && count > 0
                ? `You have ${count} ${count === 1 ? "bottle" : "bottles"}.`
                : "It's in your collection."}{" "}
              Bought another? Add it to count the extra bottle.
            </p>
          ),
          actions: (
            <>
              {addButton("Add another bottle")}
              {viewLink}
            </>
          ),
        };
      }
      if (verdict.relationship === "wishlisted") {
        return {
          tone: "wishlist",
          icon: <Heart className="size-7 text-rose-500" aria-hidden />,
          eyebrow: verdict.wishlistedNow ? "Saved" : "On your wishlist",
          title: verdict.wishlistedNow ? "Added to your wishlist" : "It's on your wishlist",
          body: <p>Buying it? Add it to your collection and it leaves the wishlist.</p>,
          actions: (
            <>
              {addButton("I bought it")}
              {viewLink}
            </>
          ),
        };
      }
      return {
        tone: "added",
        icon: <CircleCheck className="size-7 text-emerald-600 dark:text-emerald-400" aria-hidden />,
        eyebrow: "Found it",
        title: "You don't own this yet",
        body: <p>Add it to your collection, or save it to your wishlist for later.</p>,
        actions: (
          <>
            {addButton("Add to collection")}
            {verdict.shadeId && (
              <Button
                type="button"
                variant="outline"
                onClick={() => props.onAddToWishlist?.(verdict)}
                disabled={busy === "wishlisting"}
              >
                <Heart aria-hidden /> {busy === "wishlisting" ? "Saving…" : "Add to wishlist"}
              </Button>
            )}
            {viewLink}
          </>
        ),
      };
    }
    case "near_dupe":
      return {
        tone: "dupe",
        scanNextLabel: "Cancel",
        icon: <Copy className="size-7 text-orange-600 dark:text-orange-400" aria-hidden />,
        eyebrow: verdict.dupeKind === "dupe-owned" ? "You own a close dupe" : "You own something similar",
        title: "New to you — but close",
        body: <NearDupeList verdict={verdict} onLink={props.onNearDupeLink} />,
        actions: (
          <>
            <Button type="button" variant="outline" onClick={props.onAddToCollection} disabled={adding}>
              {adding ? "Adding…" : "Add anyway"}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => props.onAddToWishlist?.(verdict)}
              disabled={busy === "wishlisting"}
            >
              <Heart aria-hidden /> {busy === "wishlisting" ? "Saving…" : "Wishlist instead"}
            </Button>
            <Button asChild variant="outline">
              <Link href={detailHref(verdict.shadeId)}>View polish</Link>
            </Button>
          </>
        ),
      };
    case "unknown_barcode":
      return {
        tone: "add",
        icon: <ScanBarcode className="size-7 text-brand-purple" aria-hidden />,
        eyebrow: "Barcode not recognized",
        title: "We don't know this barcode yet",
        body: (
          <p>
            Barcode <span className="font-mono">{verdict.gtin}</span> isn&apos;t in the catalog. Photograph the
            label and we&apos;ll match it by name — then remember this barcode for your next scan.
          </p>
        ),
        actions: (
          <>
            <Button type="button" variant="outline" onClick={props.onPhotographLabel}>
              <Camera aria-hidden /> Photograph the label
            </Button>
            <Button asChild variant="outline">
              <Link href={manualAddHref({ gtin: verdict.gtin, format: verdict.format })}>Add manually</Link>
            </Button>
          </>
        ),
      };
    default:
      return assertNever(verdict);
  }
}

export function VerdictCard(props: VerdictCardProps) {
  const layout = layoutFor(props);
  const display = props.verdict.display;
  const hex =
    props.verdict.kind === "owned" || props.verdict.kind === "checked" || props.verdict.kind === "near_dupe"
      ? props.verdict.hex : undefined;

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
          {layout.scanNextLabel ? <X aria-hidden /> : <ScanBarcode aria-hidden />}{" "}
          {layout.scanNextLabel ?? "Scan next"}
        </Button>
        {layout.actions}
      </div>
    </section>
  );
}
