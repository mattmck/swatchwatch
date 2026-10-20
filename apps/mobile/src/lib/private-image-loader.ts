import { useEffect, useState } from "react";
import { API_BASE_URL } from "@/config/env";
import { getAuthorizationHeader } from "@/auth/auth-token";
import { classifyPrivateImageStatus, imageDataUri, MemoryImageCache, resolvePrivateImageUrl } from "./private-image";

/**
 * Loads owner-scoped private images (`/api/images/v3.*`) for display. Each image is fetched with
 * the caller's bearer token (never without one) and kept only in memory as a data URI; nothing
 * is written to disk and no URL or byte is logged. `clearPrivateImages()` runs on sign-out.
 */
const cache = new MemoryImageCache(24);
const inflight = new Map<string, Promise<string>>();
let generation = 0;
const listeners = new Set<() => void>();

const FETCH_TIMEOUT_MS = 30_000;

export class PrivateImageError extends Error {
  constructor(public outcome: "denied" | "error" | "offline") {
    super(outcome);
    this.name = "PrivateImageError";
  }
}

/** Forget every private image in memory and tell mounted images to drop theirs (sign-out). */
export function clearPrivateImages(): void {
  generation += 1;
  cache.clear();
  inflight.clear();
  for (const listener of listeners) listener();
}

async function fetchPrivateImage(absoluteUrl: string): Promise<string> {
  // Captured before any await, so a sign-out during the token read also discards the result.
  const started = generation;
  const authorization = await getAuthorizationHeader().catch(() => null);
  // A v3 id is useless without the owner's token: never send the request unauthenticated.
  if (!authorization || started !== generation) throw new PrivateImageError("denied");
  const controller = new AbortController();
  // The timeout covers the body read too, not just the headers.
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let dataUri: string;
  try {
    let response: Response;
    try {
      response = await fetch(absoluteUrl, { headers: { Authorization: authorization }, signal: controller.signal });
    } catch {
      throw new PrivateImageError("offline");
    }
    const outcome = classifyPrivateImageStatus(response.status);
    if (outcome !== "ready") throw new PrivateImageError(outcome);
    const buffer = await response.arrayBuffer().catch(() => {
      throw new PrivateImageError("offline");
    });
    dataUri = imageDataUri(response.headers.get("content-type"), new Uint8Array(buffer));
  } finally {
    clearTimeout(timer);
  }
  // Signed out (or switched user) while this ran: don't put the bytes back in memory.
  if (started === generation) cache.set(absoluteUrl, dataUri);
  return dataUri;
}

/** The image as an in-memory data URI (shared single flight per URL). */
export function loadPrivateImage(url: string): Promise<string> {
  const absolute = resolvePrivateImageUrl(url, API_BASE_URL);
  if (!absolute) return Promise.reject(new PrivateImageError("error"));
  const cached = cache.get(absolute);
  if (cached) return Promise.resolve(cached);
  let pending = inflight.get(absolute);
  if (!pending) {
    pending = fetchPrivateImage(absolute).finally(() => inflight.delete(absolute));
    inflight.set(absolute, pending);
  }
  return pending;
}

export type PrivateImageState =
  | { status: "idle" | "loading"; uri: null }
  | { status: "ready"; uri: string }
  | { status: "denied" | "error" | "offline"; uri: null };

/** React state for one private image URL (null = nothing to load). `reload` retries. */
export function usePrivateImage(url: string | null | undefined): PrivateImageState & { reload: () => void } {
  const [attempt, setAttempt] = useState(0);
  const [cleared, setCleared] = useState(0);
  // Settled result tagged with the request it belongs to; anything else reads as "loading".
  const [settled, setSettled] = useState<{ key: string; state: PrivateImageState } | null>(null);
  const key = url ? `${attempt}:${cleared}:${url}` : null;

  useEffect(() => {
    const onClear = () => setCleared((n) => n + 1);
    listeners.add(onClear);
    return () => {
      listeners.delete(onClear);
    };
  }, []);

  useEffect(() => {
    if (!url || !key) return;
    let cancelled = false;
    loadPrivateImage(url)
      .then((uri) => !cancelled && setSettled({ key, state: { status: "ready", uri } }))
      .catch((error: unknown) => {
        if (cancelled) return;
        const outcome = error instanceof PrivateImageError ? error.outcome : "error";
        setSettled({ key, state: { status: outcome, uri: null } });
      });
    return () => {
      cancelled = true;
    };
  }, [url, key]);

  const reload = () => setAttempt((n) => n + 1);
  if (!key) return { status: "idle", uri: null, reload };
  if (settled?.key !== key) return { status: "loading", uri: null, reload };
  return { ...settled.state, reload };
}
