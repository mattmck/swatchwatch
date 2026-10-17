"use client";

import { useId, useRef, useState } from "react";
import Link from "next/link";
import type { ActiveAddGuard, AddGuardChoiceOptions } from "@/hooks/use-add-guard";
import type { AddGuardChoice } from "@/lib/add-guard";
import {
  DUPE_GRADE_META,
  FINISH_COMPATIBILITY_LABELS,
  dupeCalloutText,
  dupeHref,
} from "@/lib/dupes";
import { resolveFinishLabel } from "@/lib/finish-options";
import { useReferenceData } from "@/hooks/use-reference-data";
import { ColorDot } from "@/components/color-dot";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface AddGuardDialogProps {
  /** The guard to show (`useAddGuard().active`); null keeps the dialog closed. */
  guard: ActiveAddGuard | null;
  onChoice: (choice: AddGuardChoice, options: AddGuardChoiceOptions) => void;
  /** `returnTo` for the dupe detail links. */
  returnTo?: string;
}

/**
 * Add guard dialog (#266): the owned near-dupes of a shade the user is about to add or
 * wishlist, as swatch pairs with grade, finish compatibility and links, plus
 * cancel / wishlist instead / add anyway. Focus starts on Cancel (the safe choice); Esc,
 * the close button and an overlay click count as cancel.
 */
export function AddGuardDialog({ guard, onChoice, returnTo }: AddGuardDialogProps) {
  // Mirrors the body's checkbox so Esc / overlay / close-button dismissals honor it too.
  const suppressRef = useRef(false);
  const handleChoice: AddGuardDialogProps["onChoice"] = (choice, options) => {
    suppressRef.current = false;
    onChoice(choice, options);
  };

  return (
    <Dialog
      open={guard !== null}
      onOpenChange={(open) => {
        if (!open && guard) handleChoice("cancelled", { suppress: suppressRef.current, via: "dismiss" });
      }}
    >
      {guard && (
        <AddGuardDialogBody
          // Remount per guard so the checkbox never carries over to another shade.
          key={`${guard.request.guardKey}:${guard.request.intent}`}
          guard={guard}
          onChoice={handleChoice}
          onSuppressChange={(value) => {
            suppressRef.current = value;
          }}
          returnTo={returnTo}
        />
      )}
    </Dialog>
  );
}

function AddGuardDialogBody({
  guard,
  onChoice,
  onSuppressChange,
  returnTo,
}: {
  guard: ActiveAddGuard;
  onChoice: AddGuardDialogProps["onChoice"];
  onSuppressChange: (value: boolean) => void;
  returnTo?: string;
}) {
  const { request, response, verdict } = guard;
  const { finishTypes } = useReferenceData();
  const [suppress, setSuppress] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const checkboxId = useId();
  const owning = request.intent === "own";
  const offerWishlist = owning && request.status !== "wishlist";
  const callout = dupeCalloutText(response);
  const targetHex = response.target.displayHex ?? undefined;

  function choose(choice: AddGuardChoice, via = "button") {
    onChoice(choice, { suppress, via });
  }

  return (
    <DialogContent
      ref={contentRef}
      className="sm:max-w-xl"
      data-testid="add-guard-dialog"
      onOpenAutoFocus={(event) => {
        // Start on Cancel rather than the first dupe link.
        event.preventDefault();
        contentRef.current?.querySelector<HTMLElement>("[data-add-guard-initial-focus]")?.focus();
      }}
    >
      <DialogHeader>
        <DialogTitle>
          {verdict === "dupe-owned" ? "You already own a close dupe" : "You own something similar"}
        </DialogTitle>
        <DialogDescription>
          {owning ? "Before adding" : "Before wishlisting"}{" "}
          <span className="font-medium text-foreground">{request.shadeLabel}</span>
          {callout ? `: ${callout.charAt(0).toLowerCase()}${callout.slice(1)}.` : "."}
        </DialogDescription>
      </DialogHeader>

      <ul className="max-h-[50vh] space-y-2 overflow-y-auto" aria-label="Owned dupes">
        {response.dupes.map((dupe) => {
          const finishes = dupe.finishes.map((finish) => resolveFinishLabel(finish, finishTypes)).join(", ");
          return (
            <li key={dupe.shadeId}>
              <Link
                href={dupeHref(dupe, returnTo)}
                onClick={() => choose("cancelled", "dupe_link")}
                className="flex items-center gap-3 rounded-lg border px-3 py-2 transition-colors hover:bg-brand-pink-light/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
              >
                <span className="flex shrink-0 items-center" aria-hidden>
                  <ColorDot hex={targetHex} size="lg" className="ring-2 ring-white/80" />
                  <ColorDot hex={dupe.displayHex} size="lg" className="-ml-3 ring-2 ring-white/80" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{dupe.name}</span>
                  <span className="block truncate text-sm text-muted-foreground">
                    {dupe.brand}
                    {finishes ? ` · ${finishes}` : ""}
                    {" · "}
                    {FINISH_COMPATIBILITY_LABELS[dupe.finishCompatibility]}
                  </span>
                </span>
                <span className="hidden font-mono text-xs text-muted-foreground sm:inline">
                  ΔE {dupe.distance.toFixed(3)}
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
      {response.dupeCount > response.dupes.length && (
        <p className="-mt-2 text-xs text-muted-foreground">
          Showing the closest {response.dupes.length} of {response.dupeCount}.
        </p>
      )}

      <div className="flex items-center gap-2 text-sm">
        <input
          id={checkboxId}
          type="checkbox"
          checked={suppress}
          onChange={(event) => {
            setSuppress(event.target.checked);
            onSuppressChange(event.target.checked);
          }}
          className="size-4 rounded border-border accent-primary"
        />
        <label htmlFor={checkboxId} className="text-muted-foreground">
          Don&apos;t warn me for this shade again this session
        </label>
      </div>

      <DialogFooter>
        <Button variant="outline" data-add-guard-initial-focus onClick={() => choose("cancelled")}>
          Cancel
        </Button>
        {offerWishlist && (
          <Button variant="secondary" onClick={() => choose("wishlisted_instead")}>
            Wishlist instead
          </Button>
        )}
        <Button onClick={() => choose("added_anyway")}>
          {owning ? "Add anyway" : "Wishlist anyway"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
