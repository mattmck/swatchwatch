"use client";

import { useState, type FormEvent } from "react";
import type { Polish, PolishStatus } from "swatchwatch-shared";
import { Check, Heart, MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { QuantityControls } from "@/components/quantity-controls";
import { POLISH_STATUS_LABELS, POLISH_STATUS_OPTIONS, isOwnedPolish } from "@/lib/inventory-status";
import {
  canMarkTried,
  isValidTriedDate,
  localIsoDate,
  type CollectionAction,
} from "@/lib/collection-actions";
import { cn } from "@/lib/utils";

/** Where an action came from (sent with the `collection.status_changed` telemetry event). */
export type QuickActionSource = "quick-action" | "menu";

interface CollectionQuickActionsProps {
  polish: Polish;
  /** True while a status/tried request for this row is in flight (actions are disabled). */
  pending?: boolean;
  onAction: (action: CollectionAction, source: QuickActionSource) => void;
  /** Quantity stepper click for owned rows (+1 / -1). */
  onQuantityChange: (delta: number) => void;
}

function formatTriedDate(triedAt: string): string {
  const date = new Date(triedAt);
  if (Number.isNaN(date.getTime())) return triedAt;
  // Tried dates are stored as UTC midnight of the chosen day: format in UTC to keep the day.
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

/**
 * Row actions for the `/polishes` table (issue #262).
 *
 * - Owned rows: the bottle stepper plus the "more" menu.
 * - Other rows: ♡ wishlist toggle (catalog, wishlist and archived rows), ✓ own, and the menu.
 * - The menu (keyboard-navigable Radix dropdown) moves the row to any status and records the
 *   tried date: today, a picked date (dialog), or back to untried.
 */
export function CollectionQuickActions({
  polish,
  pending = false,
  onAction,
  onQuantityChange,
}: CollectionQuickActionsProps) {
  const [dateDialogOpen, setDateDialogOpen] = useState(false);
  const [triedDate, setTriedDate] = useState("");
  const owned = isOwnedPolish(polish);
  const label = `${polish.brand} ${polish.name}`;
  const status = polish.status ?? null;
  const wishlisted = status === "wishlist";
  const showWishlistToggle = status === null || status === "wishlist" || status === "archived";
  const today = localIsoDate();
  const triedDateValid = isValidTriedDate(triedDate, today);

  function openDateDialog() {
    setTriedDate(polish.triedAt ? polish.triedAt.slice(0, 10) : today);
    setDateDialogOpen(true);
  }

  function submitTriedDate(event: FormEvent) {
    event.preventDefault();
    if (!triedDateValid) return;
    onAction({ kind: "set-tried", date: triedDate }, "menu");
    setDateDialogOpen(false);
  }

  return (
    <div className="inline-flex items-center justify-end gap-1">
      {owned ? (
        <QuantityControls
          owned
          quantity={polish.quantity ?? 0}
          onIncrement={() => onQuantityChange(1)}
          onDecrement={() => onQuantityChange(-1)}
          onAdd={() => onQuantityChange(1)}
          disabled={pending}
        />
      ) : (
        <div className="inline-flex w-[88px] items-center justify-end gap-1">
          {showWishlistToggle ? (
            <Button
              type="button"
              variant="outline"
              size="icon-xs"
              aria-pressed={wishlisted}
              aria-label={wishlisted ? `Remove ${label} from wishlist` : `Add ${label} to wishlist`}
              title={wishlisted ? "Remove from wishlist" : "Add to wishlist"}
              disabled={pending}
              onClick={() =>
                onAction(
                  wishlisted ? { kind: "remove-from-wishlist" } : { kind: "set-status", status: "wishlist" },
                  "quick-action"
                )
              }
              className={cn(wishlisted && "border-brand-pink/50 text-brand-pink")}
            >
              <Heart className={cn("size-3", wishlisted && "fill-current")} aria-hidden="true" />
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="xs"
            aria-label={`Mark ${label} as owned`}
            title="I own this"
            disabled={pending}
            onClick={() => onAction({ kind: "set-status", status: "owned" }, "quick-action")}
          >
            <Check className="size-3" aria-hidden="true" />
            Own
          </Button>
        </div>
      )}

      {/* modal={false}: the menu can open the date dialog without fighting it for focus. */}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`More actions for ${label}`}
            disabled={pending}
          >
            <MoreHorizontal className="size-4" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel>Status</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={status ?? ""}
            onValueChange={(value) => {
              const next = value as PolishStatus;
              if (next !== status) onAction({ kind: "set-status", status: next }, "menu");
            }}
          >
            {POLISH_STATUS_OPTIONS.map((option) => (
              <DropdownMenuRadioItem key={option} value={option}>
                {POLISH_STATUS_LABELS[option]}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          {wishlisted && (
            <DropdownMenuItem onSelect={() => onAction({ kind: "remove-from-wishlist" }, "menu")}>
              Remove from wishlist
            </DropdownMenuItem>
          )}
          {canMarkTried(polish) && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="font-normal text-muted-foreground">
                {polish.triedAt ? `Tried ${formatTriedDate(polish.triedAt)}` : "Not tried yet"}
              </DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => onAction({ kind: "set-tried", date: today }, "menu")}>
                Mark tried today
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={openDateDialog}>Mark tried on a date…</DropdownMenuItem>
              {polish.triedAt && (
                <DropdownMenuItem onSelect={() => onAction({ kind: "set-tried", date: null }, "menu")}>
                  Mark as untried
                </DropdownMenuItem>
              )}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={dateDialogOpen} onOpenChange={setDateDialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <form onSubmit={submitTriedDate} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>When did you first try it?</DialogTitle>
              <DialogDescription>{label}</DialogDescription>
            </DialogHeader>
            <div className="grid gap-2">
              <label htmlFor={`tried-date-${polish.id}`} className="text-sm font-medium">
                Tried on
              </label>
              <Input
                id={`tried-date-${polish.id}`}
                type="date"
                value={triedDate}
                max={today}
                required
                aria-invalid={triedDate !== "" && !triedDateValid}
                onChange={(event) => setTriedDate(event.target.value)}
              />
              {triedDate !== "" && !triedDateValid && (
                <p className="text-sm text-destructive">Pick a date that isn’t in the future.</p>
              )}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setDateDialogOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!triedDateValid}>
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
