/**
 * "Add SwatchWatch to your home screen" decision logic for the PWA manifest
 * (`public/manifest.json`). Chromium browsers fire `beforeinstallprompt`, which we defer
 * and replay from our own button; iOS has no install event, so iPhone/iPad users get a
 * short "Share → Add to Home Screen" hint instead. DOM-free for unit tests; the browser
 * glue is `hooks/use-install-prompt.ts`.
 */

export type InstallSurface = "installed" | "native-prompt" | "ios-hint" | "none";

export interface InstallEnvironment {
  userAgent: string;
  /** `navigator.maxTouchPoints` (iPadOS reports a desktop "Macintosh" UA). */
  maxTouchPoints: number;
  /** `display-mode: standalone` media query, or iOS `navigator.standalone`. */
  isStandalone: boolean;
  /** A deferred `beforeinstallprompt` event is available. */
  hasDeferredPrompt: boolean;
  /** `(pointer: coarse)` — the prompt is a mobile-web feature. */
  isTouchDevice: boolean;
}

export function isIosDevice(userAgent: string, maxTouchPoints: number): boolean {
  if (/iPhone|iPad|iPod/i.test(userAgent)) return true;
  // iPadOS 13+ requests the desktop site and identifies as a Mac with a touch screen.
  return /Macintosh/i.test(userAgent) && maxTouchPoints > 1;
}

/** In-app browsers (Instagram, Facebook, …) can't add to the home screen. */
export function isInAppBrowser(userAgent: string): boolean {
  return /FBAN|FBAV|Instagram|Line\/|GSA\/|TikTok|Snapchat/i.test(userAgent);
}

export function detectInstallSurface(env: InstallEnvironment): InstallSurface {
  if (env.isStandalone) return "installed";
  if (!env.isTouchDevice) return "none";
  if (env.hasDeferredPrompt) return "native-prompt";
  if (isIosDevice(env.userAgent, env.maxTouchPoints) && !isInAppBrowser(env.userAgent)) {
    return "ios-hint";
  }
  return "none";
}

export const INSTALL_PROMPT_DISMISSED_KEY = "swatchwatch-install-prompt-dismissed-at";
/** How long "Not now" hides the prompt. */
export const INSTALL_PROMPT_SNOOZE_MS = 14 * 24 * 60 * 60 * 1000;

/** Whether a stored dismissal timestamp still hides the prompt at `now`. */
export function isInstallPromptSnoozed(storedValue: string | null, now: number): boolean {
  if (!storedValue) return false;
  const dismissedAt = Number(storedValue);
  if (!Number.isFinite(dismissedAt) || dismissedAt <= 0) return false;
  // A timestamp from the future (clock change) shouldn't hide the prompt forever.
  if (dismissedAt > now) return false;
  return now - dismissedAt < INSTALL_PROMPT_SNOOZE_MS;
}
