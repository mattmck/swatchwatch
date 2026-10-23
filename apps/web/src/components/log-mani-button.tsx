"use client";

import { useState } from "react";
import { CalendarHeart, Loader2 } from "lucide-react";
import type { ManicureWearStat, Polish } from "swatchwatch-shared";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { createManicure, deleteManicure } from "@/lib/api";
import { canLogPolish, quickLogRequest, toLocalIsoDate, type QuickLogCompanion } from "@/lib/mani-log";
import { trackManiLogged } from "@/lib/metrics-events";

interface LogManiButtonProps {
  polish: Pick<Polish, "id" | "brand" | "name" | "status" | "finish" | "finishes">;
  /** `icon` renders a compact icon-only button (table rows). */
  variant?: "default" | "icon";
  className?: string;
  /** Called with the recomputed wear stats after a log or an undo. */
  onWearStatsChange?: (stats: ManicureWearStat[]) => void;
  /** Extra polishes logged in the same mani (e.g. "Pick for me" pairings), with their roles. */
  companions?: readonly QuickLogCompanion[];
  /** Called after a successful log (before any undo). */
  onLogged?: (manicureId: string) => void;
  /** Disabled while offline (a saved copy is shown): the log needs the API. */
  disabled?: boolean;
}

/**
 * One-tap "Log today's mani" for a single polish (issue #269). Logs a manicure dated today
 * (the user's local date) with this polish, then offers Undo in the toast. Renders nothing for
 * polishes the user has no inventory row for, since the API only accepts the caller's own.
 */
export function LogManiButton({
  polish,
  variant = "default",
  className,
  onWearStatsChange,
  companions = [],
  onLogged,
  disabled = false,
}: LogManiButtonProps) {
  const [pending, setPending] = useState(false);

  if (!canLogPolish(polish)) return null;

  async function handleClick() {
    setPending(true);
    try {
      const logged = await createManicure(quickLogRequest(polish, toLocalIsoDate(new Date()), companions));
      trackManiLogged({ polishCount: logged.polishes.length, via: "quick" });
      onWearStatsChange?.(logged.wearStats);
      onLogged?.(logged.id);
      const stat = logged.wearStats.find((s) => s.shadeId === polish.id);
      toast.success("Logged today's mani", {
        description: `${polish.brand} ${polish.name}${stat ? ` · worn ${stat.wearCount}×` : ""}${
          companions.length > 0 ? ` + ${companions.length} more` : ""
        }`,
        action: {
          label: "Undo",
          onClick: () => {
            deleteManicure(logged.id)
              .then((removed) => {
                onWearStatsChange?.(removed.wearStats);
                toast("Mani removed");
              })
              .catch((err: unknown) => {
                toast.error("Undo failed", {
                  description: err instanceof Error ? err.message : "Could not remove the mani.",
                });
              });
          },
        },
      });
    } catch (err: unknown) {
      toast.error("Couldn't log the mani", {
        description: err instanceof Error ? err.message : "Please try again.",
      });
    } finally {
      setPending(false);
    }
  }

  const label = `Log today's mani with ${polish.brand} ${polish.name}${
    companions.length > 0 ? ` and ${companions.length} paired ${companions.length === 1 ? "polish" : "polishes"}` : ""
  }`;

  if (variant === "icon") {
    return (
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        className={className}
        onClick={handleClick}
        disabled={pending || disabled}
        aria-label={label}
        title="Log today's mani"
      >
        {pending ? <Loader2 className="animate-spin" /> : <CalendarHeart />}
      </Button>
    );
  }

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className={className}
      onClick={handleClick}
      disabled={pending || disabled}
      aria-label={label}
    >
      {pending ? <Loader2 className="size-4 animate-spin" /> : <CalendarHeart className="size-4" />}
      {pending ? "Logging…" : "Log today's mani"}
    </Button>
  );
}
