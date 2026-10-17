"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  detectInstallSurface,
  INSTALL_PROMPT_DISMISSED_KEY,
  isInstallPromptSnoozed,
  type InstallSurface,
} from "@/lib/install-prompt";

/** Chromium's `beforeinstallprompt` event (not in lib.dom). */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

const noopSubscribe = () => () => {};

function readStandalone(): boolean {
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return iosStandalone || window.matchMedia?.("(display-mode: standalone)").matches === true;
}

function readSnoozed(): boolean {
  try {
    return isInstallPromptSnoozed(window.localStorage.getItem(INSTALL_PROMPT_DISMISSED_KEY), Date.now());
  } catch {
    return false;
  }
}

/**
 * Tracks whether to offer "install SwatchWatch": defers Chromium's `beforeinstallprompt`
 * so our own button can replay it, falls back to an iOS hint, and remembers "Not now"
 * for a couple of weeks.
 */
export function useInstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  // False during the static prerender so server and first client render agree (hidden).
  const isClient = useSyncExternalStore(noopSubscribe, () => true, () => false);

  useEffect(() => {
    function handleBeforeInstall(event: Event) {
      event.preventDefault();
      setDeferred(event as BeforeInstallPromptEvent);
    }
    function handleInstalled() {
      setDeferred(null);
      setInstalled(true);
    }
    window.addEventListener("beforeinstallprompt", handleBeforeInstall);
    window.addEventListener("appinstalled", handleInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstall);
      window.removeEventListener("appinstalled", handleInstalled);
    };
  }, []);

  const surface: InstallSurface = !isClient
    ? "none"
    : installed
      ? "installed"
      : detectInstallSurface({
          userAgent: navigator.userAgent,
          maxTouchPoints: navigator.maxTouchPoints ?? 0,
          isStandalone: readStandalone(),
          hasDeferredPrompt: deferred !== null,
          isTouchDevice: window.matchMedia?.("(pointer: coarse)").matches === true,
        });

  const promptInstall = useCallback(async () => {
    if (!deferred) return;
    await deferred.prompt();
    const choice = await deferred.userChoice.catch(() => null);
    // A deferred event can only be prompted once.
    setDeferred(null);
    if (choice?.outcome === "accepted") setInstalled(true);
  }, [deferred]);

  const dismiss = useCallback(() => {
    setDismissed(true);
    try {
      window.localStorage.setItem(INSTALL_PROMPT_DISMISSED_KEY, String(Date.now()));
    } catch {
      // Private mode / blocked storage: hiding it for this visit is enough.
    }
  }, []);

  const snoozed = dismissed || (isClient && readSnoozed());
  const visible = !snoozed && (surface === "native-prompt" || surface === "ios-hint");
  return { surface, visible, promptInstall, dismiss };
}
