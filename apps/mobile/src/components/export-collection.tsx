import { useCallback, useRef, useState } from "react";
import { Alert, Platform, View } from "react-native";
import { POLISH_STATUSES, type CollectionExportFormat, type PolishStatus } from "swatchwatch-shared";
import { errorMessage } from "@/api/client";
import { shareCollectionExport } from "@/lib/share-export";
import { POLISH_STATUS_LABELS } from "@/lib/status";
import { useTheme } from "@/theme/theme";
import { AppText, Button, Card, Chip, ErrorBanner } from "./ui";

const FORMAT_LABELS: Record<CollectionExportFormat, string> = { csv: "CSV", json: "JSON" };

/** Runs one export at a time and keeps its outcome for the UI. */
export function useCollectionExport() {
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const busy = useRef(false);

  const run = useCallback(async (format: CollectionExportFormat, status: readonly PolishStatus[] = []) => {
    if (busy.current) return;
    busy.current = true;
    setExporting(true);
    setError(null);
    setNotice(null);
    try {
      const result = await shareCollectionExport(format, status);
      if (result === "downloaded") setNotice(`Downloaded your collection as ${FORMAT_LABELS[format]}.`);
    } catch (err) {
      setError(errorMessage(err, "Couldn't export your collection."));
    } finally {
      busy.current = false;
      setExporting(false);
    }
  }, []);

  return { exporting, error, notice, run };
}

/**
 * Ask CSV or JSON, then export everything (Insights header). The web preview has no
 * multi-button alerts, so it exports CSV straight away.
 */
export function promptCollectionExport(run: (format: CollectionExportFormat) => void): void {
  if (Platform.OS === "web") {
    run("csv");
    return;
  }
  Alert.alert("Export collection", "Share your whole collection as a file.", [
    { text: "CSV (spreadsheet)", onPress: () => run("csv") },
    { text: "JSON", onPress: () => run("json") },
    { text: "Cancel", style: "cancel" },
  ]);
}

/**
 * Profile's "Export collection" card (web: the `/polishes` Export menu): CSV or JSON, every
 * status or just one, shared through the OS share sheet. CSV re-imports on the web without
 * remapping (`POLISH_CSV_COLUMNS`).
 */
export function ExportCollectionCard() {
  const theme = useTheme();
  const [format, setFormat] = useState<CollectionExportFormat>("csv");
  const [status, setStatus] = useState<PolishStatus | null>(null);
  const { exporting, error, notice, run } = useCollectionExport();

  return (
    <Card testID="export-card">
      <AppText variant="label" muted>
        Export collection
      </AppText>
      <AppText variant="small" muted>
        Save or send your polishes as a file. CSV opens in any spreadsheet and imports back into SwatchWatch.
      </AppText>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.spacing(1.5) }}>
        {(Object.keys(FORMAT_LABELS) as CollectionExportFormat[]).map((f) => (
          <Chip key={f} label={FORMAT_LABELS[f]} selected={format === f} onPress={() => setFormat(f)} />
        ))}
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.spacing(1.5) }}>
        <Chip label="Everything" selected={status === null} onPress={() => setStatus(null)} />
        {POLISH_STATUSES.map((s) => (
          <Chip key={s} label={POLISH_STATUS_LABELS[s]} selected={status === s} onPress={() => setStatus(s)} />
        ))}
      </View>
      {error && <ErrorBanner message={error} onRetry={() => void run(format, status ? [status] : [])} />}
      {notice && (
        <AppText variant="small" style={{ color: theme.colors.success }}>
          {notice}
        </AppText>
      )}
      <Button
        title={`Export ${FORMAT_LABELS[format]}`}
        variant="outline"
        loading={exporting}
        onPress={() => void run(format, status ? [status] : [])}
        testID="export-collection"
      />
    </Card>
  );
}
