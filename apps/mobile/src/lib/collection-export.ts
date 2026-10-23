/**
 * Collection export on mobile (#264 on the web): pure parts of the flow in
 * `share-export.ts`. The export comes from `GET /api/polishes/export` with the bearer token,
 * is written to the app cache directory and handed to the OS share sheet.
 */
import { collectionExportFilename, type CollectionExportFormat, type PolishStatus } from "swatchwatch-shared";

/** `/polishes/export?format=…[&status=…]` (relative to the API base URL). */
export function collectionExportPath(format: CollectionExportFormat, status: readonly PolishStatus[] = []): string {
  const params = [`format=${encodeURIComponent(format)}`];
  if (status.length > 0) params.push(`status=${encodeURIComponent(status.join(","))}`);
  return `/polishes/export?${params.join("&")}`;
}

/**
 * Filename from a `Content-Disposition` header (`filename*=UTF-8''…` preferred, then
 * `filename="…"` / `filename=…`; web: `filenameFromContentDisposition`). Path separators and
 * control characters are stripped. Null when absent or unusable.
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
  // eslint-disable-next-line no-control-regex
  const safe = name.replace(/[\\/]/g, "_").replace(/[\u0000-\u001f]/g, "").trim();
  return safe && safe !== "." && safe !== ".." ? safe : null;
}

/** The file name to save as: the server's, else `swatchwatch-collection-YYYY-MM-DD.<format>`. */
export function exportFilename(format: CollectionExportFormat, contentDisposition: string | null, now: Date = new Date()): string {
  const fromHeader = filenameFromContentDisposition(contentDisposition);
  if (fromHeader && fromHeader.toLowerCase().endsWith(`.${format}`)) return fromHeader;
  return collectionExportFilename(format, now);
}

/** MIME type (Android intent) and UTI (iOS) the share sheet is given for a format. */
export function exportShareType(format: CollectionExportFormat): { mimeType: string; UTI: string } {
  return format === "csv"
    ? { mimeType: "text/csv", UTI: "public.comma-separated-values-text" }
    : { mimeType: "application/json", UTI: "public.json" };
}
