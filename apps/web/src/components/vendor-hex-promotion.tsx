"use client";

import { useState } from "react";
import { ArrowUpToLine, BadgeCheck, Undo2 } from "lucide-react";
import { toast } from "sonner";
import type { HexLabelPromoteResponse, HexLabelQueueItem } from "swatchwatch-shared";
import { promoteHexLabel, undoVendorHexPromotion } from "@/lib/api";
import { vendorHexPromotionState } from "@/lib/vendor-hex-promotion";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function Hex({ hex }: { hex: string | null }) {
  return hex ? (
    <span className="inline-flex items-center gap-1 font-mono">
      <span className="inline-block size-3 rounded-sm border border-border" style={{ backgroundColor: hex }} />
      {hex}
    </span>
  ) : (
    <span className="font-mono">none</span>
  );
}

/**
 * Admin "Promote to vendor hex" control for the shade's saved manual label (#321, decision D12).
 * Off by default: nothing is promoted until the admin confirms in a dialog. Once promoted it shows
 * the state with an Undo that restores the vendor hex the promotion replaced. Promotion writes
 * `shade.vendor_hex` (catalog data every user sees) and an audit row; ingestion never overwrites it.
 */
export function VendorHexPromotion({
  item,
  disabled = false,
  onChange,
}: {
  item: HexLabelQueueItem;
  disabled?: boolean;
  onChange: (response: HexLabelPromoteResponse) => void;
}) {
  const state = vendorHexPromotionState(item);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  if (state.kind === "none") return null;

  async function promote(labelId: string) {
    setBusy(true);
    try {
      const response = await promoteHexLabel(labelId);
      onChange(response);
      setConfirmOpen(false);
      toast.success(`Vendor hex set to ${response.vendorHex}`, {
        description: "Ingestion will not overwrite it. Undo restores the previous vendor hex.",
      });
    } catch (error) {
      toast.error("Failed to promote label", { description: errorMessage(error, "Request failed") });
    } finally {
      setBusy(false);
    }
  }

  async function undo() {
    setBusy(true);
    try {
      const response = await undoVendorHexPromotion(item.shadeId);
      onChange(response);
      toast.success(response.vendorHex ? `Vendor hex restored to ${response.vendorHex}` : "Vendor hex cleared");
    } catch (error) {
      toast.error("Undo failed", { description: errorMessage(error, "Request failed") });
    } finally {
      setBusy(false);
    }
  }

  const promotable = state.kind === "available" || state.kind === "stale" ? state : null;
  const previous = state.kind === "available" ? item.vendorHex : state.previous;

  return (
    <div className="space-y-2 rounded-lg border border-border p-3 text-xs" data-testid="vendor-hex-promotion">
      {state.kind === "available" ? (
        <p className="text-muted-foreground">
          Labels are eval-only. Promote this one to make <Hex hex={state.hex} /> the shade&apos;s vendor hex.
        </p>
      ) : (
        <p className="flex flex-wrap items-center gap-1">
          <BadgeCheck className="size-3.5 text-primary" />
          <span className="font-medium">Promoted</span>
          <span className="text-muted-foreground">
            vendor hex is <Hex hex={state.kind === "promoted" ? state.hex : state.promotedHex} /> from a manual label
            {state.kind === "stale" ? <> (label is now <Hex hex={state.hex} />)</> : null}
            {state.kind === "orphaned" ? " (label since removed)" : null} · was <Hex hex={previous} />
          </span>
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {promotable ? (
          <Button type="button" size="sm" variant="outline" disabled={disabled || busy} onClick={() => setConfirmOpen(true)}>
            <ArrowUpToLine className="size-4" />
            {state.kind === "stale" ? "Promote new hex" : "Promote to vendor hex"}
          </Button>
        ) : null}
        {state.kind !== "available" ? (
          <Button type="button" size="sm" variant="ghost" disabled={disabled || busy} onClick={() => void undo()}>
            <Undo2 className="size-4" /> Undo promotion
          </Button>
        ) : null}
      </div>

      {promotable ? (
        <Dialog open={confirmOpen} onOpenChange={(open) => !busy && setConfirmOpen(open)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Promote to vendor hex?</DialogTitle>
              <DialogDescription>
                {item.brand} {item.name}: the vendor hex changes from <Hex hex={previous} /> to <Hex hex={promotable.hex} />.
                Every user sees it as this shade&apos;s colour, and future ingests will not overwrite it. You can undo
                this later; the change is recorded in the admin audit log.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={busy} onClick={() => setConfirmOpen(false)}>
                Cancel
              </Button>
              <Button type="button" disabled={busy} onClick={() => void promote(promotable.labelId)}>
                {busy ? "Promoting…" : "Promote"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
