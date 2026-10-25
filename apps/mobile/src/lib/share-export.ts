/**
 * Export the collection through the OS share sheet: download `GET /api/polishes/export` with the
 * bearer token, write it to the app cache directory (`expo-file-system`), open the share sheet
 * (`expo-sharing`). The temp file lives in its own cache folder, which is emptied before every
 * export, right after the share sheet closes on iOS, and on sign-out (`clearExportFiles`). Android
 * is not cleaned up right away because the receiving app may still be reading the file after
 * the chooser returns. The web preview saves it with a download link instead. The file contents
 * are never logged or kept anywhere else.
 */
import { Directory, File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { Platform } from "react-native";
import type { CollectionExportFormat, PolishStatus } from "swatchwatch-shared";
import { downloadCollectionExport } from "@/api/client";
import { exportFilename, exportShareType } from "./collection-export";

export type ShareExportResult = "shared" | "downloaded";

export async function shareCollectionExport(
  format: CollectionExportFormat,
  status: readonly PolishStatus[] = [],
): Promise<ShareExportResult> {
  if (Platform.OS !== "web" && !(await Sharing.isAvailableAsync())) {
    throw new Error("Sharing isn't available on this device.");
  }
  const { text, contentDisposition } = await downloadCollectionExport(format, status);
  const filename = exportFilename(format, contentDisposition);
  const { mimeType, UTI } = exportShareType(format);

  if (Platform.OS === "web") {
    downloadOnWeb(text, filename, mimeType);
    return "downloaded";
  }

  clearExportFiles();
  const dir = exportDirectory();
  dir.create({ intermediates: true, idempotent: true });
  const file = new File(dir, filename);
  try {
    file.create({ overwrite: true });
    file.write(text);
    await Sharing.shareAsync(file.uri, { mimeType, UTI, dialogTitle: "Export collection" });
    return "shared";
  } finally {
    // On iOS the share sheet has copied the file (or was dismissed) once shareAsync resolves.
    if (Platform.OS === "ios") clearExportFiles();
  }
}

function exportDirectory(): Directory {
  return new Directory(Paths.cache, "collection-export");
}

/** Delete every exported file left in the cache (before an export and on sign-out). */
export function clearExportFiles(): void {
  if (Platform.OS === "web") return;
  try {
    const dir = exportDirectory();
    if (dir.exists) dir.delete();
  } catch {
    // The OS clears the cache directory eventually.
  }
}

function downloadOnWeb(text: string, filename: string, mimeType: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${mimeType};charset=utf-8` }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
