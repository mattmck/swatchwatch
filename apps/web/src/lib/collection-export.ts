/**
 * Collection export download (issue #264).
 *
 * The export is fetched through the authenticated API (`GET /api/polishes/export`) with the
 * caller's `Authorization` header, turned into a Blob and saved through a temporary object URL.
 * A bare `<a href>` would not carry the bearer token. Dependencies are injected so the flow is
 * unit-tested without a browser.
 */
import {
  collectionExportFilename,
  type CollectionExportFormat,
  type PolishStatus,
} from "swatchwatch-shared";

export interface CollectionExportDeps {
  fetch: typeof fetch;
  apiBaseUrl: string;
  getAuthHeaders: () => Promise<Record<string, string>>;
  now?: () => Date;
}

export interface CollectionExportOptions {
  /** Only export these statuses; omit (or empty) for every status. */
  status?: readonly PolishStatus[];
}

export interface DownloadedCollectionExport {
  blob: Blob;
  filename: string;
}

export class CollectionExportError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "CollectionExportError";
  }
}

/** `${apiBaseUrl}/polishes/export?format=…[&status=…]`. */
export function buildCollectionExportUrl(
  apiBaseUrl: string,
  format: CollectionExportFormat,
  options: CollectionExportOptions = {}
): string {
  const params = new URLSearchParams({ format });
  if (options.status && options.status.length > 0) params.set("status", options.status.join(","));
  return `${apiBaseUrl.replace(/\/+$/, "")}/polishes/export?${params.toString()}`;
}

/**
 * Filename from a `Content-Disposition` header (`filename*=UTF-8''…` preferred, then
 * `filename="…"` / `filename=…`). Path separators are stripped. Null when absent or unusable.
 */
export function filenameFromContentDisposition(header: string | null | undefined): string | null {
  if (!header) return null;
  let name: string | null = null;
  const extended = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  if (extended) {
    try {
      name = decodeURIComponent(extended[1].trim().replace(/^"|"$/g, ""));
    } catch {
      name = null;
    }
  }
  if (!name) {
    const quoted = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(header);
    const bare = /filename\s*=\s*([^";\s][^;]*)/.exec(header);
    name = quoted ? quoted[1].replace(/\\(.)/g, "$1") : bare ? bare[1].trim() : null;
  }
  if (!name) return null;
  const safe = name.replace(/[\\/]/g, "_").replace(/[\u0000-\u001f]/g, "").trim();
  return safe && safe !== "." && safe !== ".." ? safe : null;
}

/** Fetch the export with auth headers and return it as a Blob plus the filename to save as. */
export async function fetchCollectionExport(
  format: CollectionExportFormat,
  deps: CollectionExportDeps,
  options: CollectionExportOptions = {}
): Promise<DownloadedCollectionExport> {
  const response = await deps.fetch(buildCollectionExportUrl(deps.apiBaseUrl, format, options), {
    headers: await deps.getAuthHeaders(),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
    throw new CollectionExportError(
      response.status,
      body?.error || body?.message || `Export failed (HTTP ${response.status})`
    );
  }
  const blob = await response.blob();
  const filename =
    filenameFromContentDisposition(response.headers.get("Content-Disposition")) ??
    collectionExportFilename(format, deps.now ? deps.now() : new Date());
  return { blob, filename };
}

export interface SaveBlobEnv {
  document: Pick<Document, "createElement" | "body">;
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
  /** Defers the revoke so the browser has started the download (default: 1s timeout). */
  defer?: (fn: () => void) => void;
}

/** Save a Blob as a file via a temporary `<a download>` click. */
export function saveBlobAsFile(blob: Blob, filename: string, env?: SaveBlobEnv): void {
  const resolved: SaveBlobEnv = env ?? {
    document,
    createObjectURL: (value) => URL.createObjectURL(value),
    revokeObjectURL: (value) => URL.revokeObjectURL(value),
  };
  const url = resolved.createObjectURL(blob);
  const anchor = resolved.document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  resolved.document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    (resolved.defer ?? ((fn) => setTimeout(fn, 1000)))(() => resolved.revokeObjectURL(url));
  }
}
