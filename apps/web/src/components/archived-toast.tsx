"use client";

import { useState } from "react";
import { ARCHIVE_REASONS, ARCHIVE_REASON_LABELS, type ArchiveReason, type Polish } from "swatchwatch-shared";
import { toast } from "sonner";
import { updatePolish } from "@/lib/api";
import { archiveReasonUpdate, undoArchiveUpdate } from "@/lib/inventory-status";
import { cn } from "@/lib/utils";

/** How long the archive toast stays up: long enough to pick a reason. */
const ARCHIVED_TOAST_MS = 10_000;

interface ArchivedToastOptions {
  polish: Pick<Polish, "id" | "brand" | "name">;
  /** Called with the polish the API returned after a reason change or an undo. */
  onUpdated?: (polish: Polish) => void;
}

/**
 * "Archived — Used up · Gave away · Undo" (decision D5c). Shown after an owned polish is
 * archived by running out (− on the last bottle, or saving 0 bottles in the edit form). The
 * API already recorded `used_up`; picking Gave away corrects the reason, Undo restores
 * `owned` with one bottle and removes the reason.
 */
export function showArchivedToast({ polish, onUpdated }: ArchivedToastOptions) {
  const id = toast.success("Archived", {
    description: <ArchiveReasonPicker polish={polish} onUpdated={onUpdated} />,
    duration: ARCHIVED_TOAST_MS,
    action: {
      label: "Undo",
      onClick: () => {
        updatePolish(polish.id, undoArchiveUpdate())
          .then((restored) => {
            onUpdated?.(restored);
            toast(`${polish.brand} ${polish.name} is back in your collection`);
          })
          .catch((err: unknown) => {
            toast.error("Undo failed", {
              description: err instanceof Error ? err.message : "Could not restore the polish.",
            });
          });
      },
    },
  });
  return id;
}

function ArchiveReasonPicker({ polish, onUpdated }: ArchivedToastOptions) {
  const [reason, setReason] = useState<ArchiveReason>("used_up");
  const [pending, setPending] = useState(false);

  async function choose(next: ArchiveReason) {
    if (next === reason || pending) return;
    const previous = reason;
    setReason(next);
    setPending(true);
    try {
      onUpdated?.(await updatePolish(polish.id, archiveReasonUpdate(next)));
    } catch (err: unknown) {
      setReason(previous);
      toast.error("Couldn't save the reason", {
        description: err instanceof Error ? err.message : "Please try again.",
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <span className="flex flex-wrap items-center gap-1">
      <span>
        {polish.brand} {polish.name} ·
      </span>
      {ARCHIVE_REASONS.map((value, index) => (
        <span key={value} className="flex items-center gap-1">
          {index > 0 && <span aria-hidden="true">·</span>}
          <button
            type="button"
            className={cn(
              "rounded px-1 underline-offset-2 hover:underline disabled:opacity-60",
              reason === value && "font-semibold underline"
            )}
            aria-pressed={reason === value}
            disabled={pending}
            onClick={() => choose(value)}
          >
            {ARCHIVE_REASON_LABELS[value]}
          </button>
        </span>
      ))}
    </span>
  );
}
