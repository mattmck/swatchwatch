"use client";

import { useCallback, useEffect, useState } from "react";
import type { WishlistShareStatus } from "swatchwatch-shared";
import { WISHLIST_SHARE_DISPLAY_NAME_MAX_LENGTH } from "swatchwatch-shared";
import { Copy, Link2, Loader2, RefreshCw, Share2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  enableWishlistShare,
  getWishlistShare,
  revokeWishlistShare,
  rotateWishlistShare,
} from "@/lib/api";
import { buildWishlistShareUrl, wishlistSharePrivacyNote } from "@/lib/wishlist-share";

type Busy = "enable" | "rename" | "rotate" | "revoke" | null;

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * Owner controls for the opt-in public wishlist link (#268): enable, copy, rotate, revoke, and an
 * optional public display name. Renders nothing while loading, when the server-side
 * `SHAREABLE_WISHLIST_ENABLED` flag is off (the status endpoint answers `feature_disabled`), or
 * when the status cannot be loaded.
 */
export function WishlistShareCard() {
  const [status, setStatus] = useState<WishlistShareStatus | null | undefined>(undefined);
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState<Busy>(null);

  const apply = useCallback((next: WishlistShareStatus) => {
    setStatus(next);
    setDisplayName(next.displayName ?? "");
  }, []);

  useEffect(() => {
    let cancelled = false;
    getWishlistShare()
      .then((next) => {
        if (cancelled) return;
        if (next) apply(next);
        else setStatus(null);
      })
      .catch((error) => {
        if (cancelled) return;
        console.warn("[wishlist-share] status unavailable:", error);
        setStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [apply]);

  if (!status) return null;

  const shareUrl =
    status.path && typeof window !== "undefined"
      ? buildWishlistShareUrl(window.location.origin, status.path)
      : null;
  const savedName = status.displayName ?? "";
  const nameChanged = displayName.trim() !== savedName;

  async function run(kind: Exclude<Busy, null>, action: () => Promise<WishlistShareStatus>, success: string) {
    setBusy(kind);
    try {
      apply(await action());
      toast.success(success);
    } catch (error) {
      toast.error(errorMessage(error, "Something went wrong. Try again."));
    } finally {
      setBusy(null);
    }
  }

  async function copyLink() {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      toast.success("Link copied");
    } catch {
      toast.error("Couldn't copy the link. Select it and copy it manually.");
    }
  }

  const nameInput = (
    <div className="flex flex-col gap-1.5">
      <label htmlFor="wishlist-share-name" className="text-sm font-medium">
        Display name <span className="font-normal text-muted-foreground">(optional, shown on the page)</span>
      </label>
      <div className="flex flex-wrap gap-2">
        <Input
          id="wishlist-share-name"
          value={displayName}
          maxLength={WISHLIST_SHARE_DISPLAY_NAME_MAX_LENGTH}
          placeholder="e.g. Sam"
          onChange={(event) => setDisplayName(event.target.value)}
          className="max-w-xs"
          disabled={busy !== null}
        />
        {status.enabled && (
          <Button
            variant="outline"
            size="sm"
            className="h-9"
            disabled={!nameChanged || busy !== null}
            onClick={() =>
              run("rename", () => enableWishlistShare({ displayName: displayName.trim() || null }), "Display name saved")
            }
          >
            {busy === "rename" && <Loader2 className="size-4 animate-spin" />}
            Save name
          </Button>
        )}
      </div>
    </div>
  );

  return (
    <Card className="gap-4 border-brand-purple/20">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Share2 className="size-4 text-brand-purple" aria-hidden />
          Share your wishlist
        </CardTitle>
        <CardDescription>{wishlistSharePrivacyNote(status.wishlistCount, status.hiddenCount)}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {nameInput}

        {!status.enabled ? (
          <div>
            <Button
              disabled={busy !== null}
              onClick={() =>
                run("enable", () => enableWishlistShare({ displayName: displayName.trim() || null }), "Share link created")
              }
            >
              {busy === "enable" ? <Loader2 className="size-4 animate-spin" /> : <Link2 className="size-4" />}
              Create share link
            </Button>
          </div>
        ) : (
          <>
            {shareUrl ? (
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  readOnly
                  value={shareUrl}
                  aria-label="Share link"
                  className="max-w-md font-mono text-xs"
                  onFocus={(event) => event.currentTarget.select()}
                />
                <Button variant="outline" size="sm" className="h-9" onClick={copyLink}>
                  <Copy className="size-4" />
                  Copy link
                </Button>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                Your link is still active, but it can no longer be shown here. Replace it to get a new link to copy.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={busy !== null}
                onClick={() => {
                  if (!window.confirm("Replace the link? Anyone using the current link will lose access.")) return;
                  void run("rotate", rotateWishlistShare, "New link created; the old one no longer works");
                }}
              >
                {busy === "rotate" ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                Replace link
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="text-destructive hover:text-destructive"
                disabled={busy !== null}
                onClick={() => {
                  if (!window.confirm("Turn off sharing? The link will stop working immediately.")) return;
                  void run("revoke", revokeWishlistShare, "Sharing turned off");
                }}
              >
                {busy === "revoke" ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                Turn off sharing
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
