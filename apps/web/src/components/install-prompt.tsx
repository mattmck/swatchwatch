"use client";

import { Share, Smartphone, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useInstallPrompt } from "@/hooks/use-install-prompt";

/**
 * Mobile-web "add to home screen" banner for the PWA manifest. Uses the deferred
 * `beforeinstallprompt` on Chromium and a Share → Add to Home Screen hint on iOS; hidden
 * on desktop, once installed, and for two weeks after "Not now".
 */
export function InstallPrompt() {
  const { surface, visible, promptInstall, dismiss } = useInstallPrompt();
  if (!visible) return null;

  return (
    <aside
      aria-label="Install SwatchWatch"
      className="flex items-start gap-3 rounded-xl border border-brand-purple/30 bg-brand-pink-light/15 p-3 text-sm"
    >
      <Smartphone className="mt-0.5 size-5 shrink-0 text-brand-purple" aria-hidden />
      <div className="min-w-0 flex-1 space-y-2">
        <p className="font-medium">Keep SwatchWatch on your home screen</p>
        {surface === "native-prompt" ? (
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="brand" onClick={() => void promptInstall()}>
              Install app
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={dismiss}>
              Not now
            </Button>
          </div>
        ) : (
          <p className="text-muted-foreground">
            Tap <Share className="inline size-4 align-text-bottom" aria-label="Share" /> then{" "}
            <span className="font-medium text-foreground">Add to Home Screen</span> to open Rapid Add in one tap.
          </p>
        )}
      </div>
      {surface === "ios-hint" && (
        <Button type="button" size="icon-sm" variant="ghost" onClick={dismiss} aria-label="Dismiss">
          <X aria-hidden />
        </Button>
      )}
    </aside>
  );
}
