import { useEffect, useState } from "react";
import { API_BASE_URL, getAuthHeaders } from "./api";

/**
 * Owner-scoped private image ids minted by the Functions API (#227) look like
 * `/api/images/v3.<payload>.<exp>.<uid>.<sig>`. Serving one requires the
 * owner's bearer token, which `<img src>` cannot send, so these are fetched
 * with `Authorization` and rendered through an object URL instead.
 *
 * Public catalog images keep `v2.` ids and render with a plain `<img>`.
 */
const PRIVATE_IMAGE_PATH_PREFIX = "/api/images/v3.";

/** Base used only to parse relative URLs; never fetched. */
const RELATIVE_URL_BASE = "http://relative.invalid";
const RELATIVE_URL_ORIGIN = new URL(RELATIVE_URL_BASE).origin;

/**
 * Origin of the API base URL `api.ts` calls. The API mints image ids against
 * the origin of the request it serves, so this is the only absolute origin a
 * private id can legitimately carry. A relative base resolves against
 * `window.location.origin`; without a window (SSR) it yields `null`, so only
 * relative image URLs count as private there.
 */
export function defaultApiOrigin(): string | null {
  const windowOrigin = typeof window !== "undefined" ? window.location.origin : undefined;
  try {
    return new URL(API_BASE_URL, windowOrigin).origin;
  } catch {
    return null;
  }
}

export type PrivateImageStatus = "idle" | "loading" | "ready" | "denied" | "error";

export interface PrivateImageState {
  status: PrivateImageStatus;
  objectUrl: string | null;
}

/** Terminal states a single private-image load can end in. */
export type PrivateImageOutcome = Extract<PrivateImageStatus, "ready" | "denied" | "error">;

const IDLE_STATE: PrivateImageState = { status: "idle", objectUrl: null };
const LOADING_STATE: PrivateImageState = { status: "loading", objectUrl: null };

/**
 * True when `url` points at an owner-scoped `v3` image id that is safe to
 * fetch with the bearer token: the path starts with `/api/images/v3.` and the
 * URL is either relative or on `apiOrigin` (default: the API base URL's
 * origin). The same path on any other host is not private, so it renders as a
 * plain `<img>` and no token is sent. False for `v2` ids, data/blob URLs and
 * unparsable input.
 */
export function isPrivateImageUrl(
  url: string,
  apiOrigin: string | null = defaultApiOrigin()
): boolean {
  if (typeof url !== "string" || url.length === 0) {
    return false;
  }

  try {
    const parsed = new URL(url, RELATIVE_URL_BASE);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    if (!parsed.pathname.startsWith(PRIVATE_IMAGE_PATH_PREFIX)) {
      return false;
    }
    if (parsed.origin === RELATIVE_URL_ORIGIN) {
      return true;
    }
    return apiOrigin !== null && parsed.origin === apiOrigin;
  } catch {
    return false;
  }
}

/** Map an HTTP status from the image route to the load outcome. */
export function classifyPrivateImageResponse(status: number): PrivateImageOutcome {
  if (status >= 200 && status < 300) {
    return "ready";
  }
  if (status === 401 || status === 403) {
    return "denied";
  }
  return "error";
}

export interface PrivateImageLoaderDeps {
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  getHeaders: () => Promise<Record<string, string>>;
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (objectUrl: string) => void;
}

function defaultLoaderDeps(): PrivateImageLoaderDeps {
  return {
    fetch: (input, init) => fetch(input, init),
    getHeaders: () => getAuthHeaders(),
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (objectUrl) => URL.revokeObjectURL(objectUrl),
  };
}

export interface PrivateImageLoad {
  /** Abort the request (if still in flight) and revoke any object URL created. */
  dispose: () => void;
  /** Settles once the load has finished or been abandoned; never rejects. */
  done: Promise<void>;
}

/**
 * Framework-agnostic loader behind `usePrivateImage`. Fetches `url` with the
 * auth headers and reports exactly one terminal state through `onSettled`,
 * unless `dispose()` is called first, in which case nothing is reported and
 * any object URL is revoked.
 */
export function loadPrivateImage(
  url: string,
  onSettled: (state: PrivateImageState) => void,
  deps: PrivateImageLoaderDeps = defaultLoaderDeps()
): PrivateImageLoad {
  const controller = new AbortController();
  let disposed = false;
  let objectUrl: string | null = null;

  const done = (async () => {
    try {
      const headers = await deps.getHeaders();
      if (disposed) return;
      const response = await deps.fetch(url, { headers, signal: controller.signal });
      if (disposed) return;

      const outcome = classifyPrivateImageResponse(response.status);
      if (outcome !== "ready") {
        onSettled({ status: outcome, objectUrl: null });
        return;
      }

      const blob = await response.blob();
      if (disposed) return;
      objectUrl = deps.createObjectURL(blob);
      onSettled({ status: "ready", objectUrl });
    } catch {
      if (!disposed) {
        onSettled({ status: "error", objectUrl: null });
      }
    }
  })();

  return {
    dispose: () => {
      disposed = true;
      controller.abort();
      if (objectUrl) {
        deps.revokeObjectURL(objectUrl);
        objectUrl = null;
      }
    },
    done,
  };
}

/**
 * Load an owner-scoped private image with the current user's bearer token.
 *
 * Non-private or empty URLs return `idle` with no object URL, and callers
 * should render the plain URL. Private URLs return `loading`, then `ready`
 * with an object URL, `denied` on 401/403, or `error` otherwise. The object
 * URL is revoked when `url` changes or the component unmounts, and responses
 * for a previous `url` are ignored.
 */
export function usePrivateImage(url: string | null | undefined): PrivateImageState {
  const privateUrl = url && isPrivateImageUrl(url) ? url : null;
  const [settled, setSettled] = useState<{ url: string; state: PrivateImageState } | null>(null);

  useEffect(() => {
    if (!privateUrl) return;
    const load = loadPrivateImage(privateUrl, (state) => setSettled({ url: privateUrl, state }));
    return () => {
      load.dispose();
      // Drop the (now revoked) object URL so a later return to this url
      // shows `loading` instead of a dead blob reference.
      setSettled((current) => (current?.url === privateUrl ? null : current));
    };
  }, [privateUrl]);

  if (!privateUrl) return IDLE_STATE;
  if (!settled || settled.url !== privateUrl) return LOADING_STATE;
  return settled.state;
}
