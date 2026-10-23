/**
 * Browser glue for the PWA service worker (`scripts/build-sw.mjs` writes `out/sw.js`). Registered
 * after hydration in production builds only; development unregisters any worker so `next dev`
 * never serves stale chunks. A new worker waits (no `skipWaiting` on install) and the page offers
 * a "Reload" toast that posts `SKIP_WAITING`.
 */
import { toast } from "sonner";
import { trackEvent } from "./telemetry";

export const SW_URL = "/sw.js";

export function shouldRegisterServiceWorker(env: { nodeEnv?: string; hasServiceWorker: boolean }): boolean {
  return env.nodeEnv === "production" && env.hasServiceWorker;
}

function showUpdateToast(worker: ServiceWorker): void {
  trackEvent("pwa.sw_updated", {});
  toast("Update available", {
    id: "sw-update",
    description: "A new version of SwatchWatch is ready.",
    duration: Infinity,
    action: {
      label: "Reload",
      onClick: () => worker.postMessage({ type: "SKIP_WAITING" }),
    },
  });
}

export async function registerServiceWorker(): Promise<void> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

  if (!shouldRegisterServiceWorker({ nodeEnv: process.env.NODE_ENV, hasServiceWorker: true })) {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((r) => r.unregister()));
    return;
  }

  const hadController = navigator.serviceWorker.controller !== null;
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    // The first claim() of a fresh install is not an update; only reload when a worker replaced one.
    if (!hadController || reloading) return;
    reloading = true;
    window.location.reload();
  });

  const registration = await navigator.serviceWorker.register(SW_URL, { updateViaCache: "none" });

  // A worker already waiting from an earlier visit.
  if (registration.waiting && navigator.serviceWorker.controller) showUpdateToast(registration.waiting);

  registration.addEventListener("updatefound", () => {
    const installing = registration.installing;
    if (!installing) return;
    installing.addEventListener("statechange", () => {
      if (installing.state !== "installed") return;
      if (navigator.serviceWorker.controller) showUpdateToast(installing);
      else trackEvent("pwa.sw_installed", {});
    });
  });
}
