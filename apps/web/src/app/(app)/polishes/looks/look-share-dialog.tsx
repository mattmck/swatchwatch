"use client";

import { useState } from "react";
import type { LookShareStatus } from "swatchwatch-shared";
import { WISHLIST_SHARE_DISPLAY_NAME_MAX_LENGTH } from "swatchwatch-shared";
import { Copy, Link2, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { createLookShare, revokeLookShare } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { buildLookShareUrl, LOOK_SHARE_PRIVACY_NOTE } from "@/lib/look-share";

export interface LookShareTarget {
  /** The saved look's key (`SavedLook.id`). */
  lookKey: string;
  name: string;
}

interface LookShareDialogProps {
  /** The saved look to share; null closes the dialog. */
  target: LookShareTarget | null;
  /** The look's live link, or null when it has none. */
  status: LookShareStatus | null;
  onOpenChange: (open: boolean) => void;
  /** Called with the new status after creating, renaming or turning off the link. */
  onChange: (status: LookShareStatus) => void;
}

type Busy = "create" | "rename" | "revoke" | null;

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * Owner controls for one saved look's public link (behind `SHAREABLE_LOOKS_ENABLED`; the page only
 * offers it when `GET /api/look-share` answers): privacy note, optional display name, create +
 * copy, copy again, and turn off. Render it with `key={target?.lookKey}`.
 */
export function LookShareDialog({ target, status, onOpenChange, onChange }: LookShareDialogProps) {
  const live = status?.enabled ? status : null;
  const savedName = live?.displayName ?? "";
  // Starts from the link's current name; the page keys this dialog by look so each look starts fresh.
  const [displayName, setDisplayName] = useState(savedName);
  const [busy, setBusy] = useState<Busy>(null);
  const shareUrl = live?.path && typeof window !== "undefined" ? buildLookShareUrl(window.location.origin, live.path) : null;

  async function copyLink(url: string) {
    if (await copyText(url)) toast.success("Link copied", { description: "Anyone with it can view this look." });
    else toast.error("Couldn't copy the link", { description: "Select it and copy it manually." });
  }

  async function create() {
    if (!target) return;
    setBusy("create");
    try {
      const next = await createLookShare({ lookKey: target.lookKey, displayName: displayName.trim() || null });
      onChange(next);
      if (next.path) await copyLink(buildLookShareUrl(window.location.origin, next.path));
      else toast.success("Share link created");
    } catch (error) {
      toast.error(errorMessage(error, "Couldn't create the link. Try again."));
    } finally {
      setBusy(null);
    }
  }

  async function rename() {
    if (!target) return;
    setBusy("rename");
    try {
      onChange(await createLookShare({ lookKey: target.lookKey, displayName: displayName.trim() || null }));
      toast.success("Display name saved");
    } catch (error) {
      toast.error(errorMessage(error, "Couldn't save the name. Try again."));
    } finally {
      setBusy(null);
    }
  }

  async function revoke() {
    if (!target) return;
    if (!window.confirm("Turn off this link? It will stop working immediately.")) return;
    setBusy("revoke");
    try {
      onChange(await revokeLookShare(target.lookKey));
      toast.success("Link turned off");
    } catch (error) {
      toast.error(errorMessage(error, "Couldn't turn off the link. Try again."));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{target ? `Share ${target.name}` : "Share look"}</DialogTitle>
          <DialogDescription>{LOOK_SHARE_PRIVACY_NOTE}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="look-share-name" className="text-sm font-medium">
            Display name <span className="font-normal text-muted-foreground">(optional, shown on the page)</span>
          </label>
          <div className="flex gap-2">
            <Input
              id="look-share-name"
              value={displayName}
              maxLength={WISHLIST_SHARE_DISPLAY_NAME_MAX_LENGTH}
              placeholder="e.g. Sam"
              onChange={(event) => setDisplayName(event.target.value)}
              disabled={busy !== null}
            />
            {live && (
              <Button
                type="button"
                variant="outline"
                className="h-9 shrink-0"
                disabled={displayName.trim() === savedName || busy !== null}
                onClick={() => void rename()}
              >
                {busy === "rename" && <Loader2 className="size-4 animate-spin" aria-hidden />}
                Save name
              </Button>
            )}
          </div>
        </div>

        {live &&
          (shareUrl ? (
            <div className="flex gap-2">
              <Input
                readOnly
                value={shareUrl}
                aria-label="Share link"
                className="font-mono text-xs"
                onFocus={(event) => event.currentTarget.select()}
              />
              <Button type="button" variant="outline" className="h-9 shrink-0" onClick={() => void copyLink(shareUrl)}>
                <Copy className="size-4" aria-hidden />
                Copy
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              This link still works, but it can no longer be shown here. Turn it off and share again to get a new one.
            </p>
          ))}

        <DialogFooter>
          {live ? (
            <Button
              type="button"
              variant="outline"
              className="text-destructive hover:text-destructive"
              disabled={busy !== null}
              onClick={() => void revoke()}
            >
              {busy === "revoke" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Trash2 className="size-4" aria-hidden />}
              Turn off link
            </Button>
          ) : (
            <Button type="button" disabled={busy !== null || !target} onClick={() => void create()}>
              {busy === "create" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Link2 className="size-4" aria-hidden />}
              Create and copy link
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
