import { useRouter } from "expo-router";
import { memo, useCallback, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, ScrollView, View } from "react-native";
import {
  POLISH_IMPORT_FIELDS,
  POLISH_IMPORT_FIELD_LABELS,
  POLISH_IMPORT_REQUIRED_FIELDS,
  importRowNeedsStatus,
  type ArchiveReason,
  type PolishImportAction,
  type PolishImportColumnMapping,
  type PolishImportRow,
  type PolishImportSession,
  type PolishImportStatusChoice,
} from "swatchwatch-shared";
import { commitPolishImport, createPolishImport, errorMessage } from "@/api/client";
import { useAuth } from "@/auth/auth-provider";
import { Swatch } from "@/components/swatch";
import { AppText, Button, Card, Chip, ErrorBanner } from "@/components/ui";
import { invalidateInventoryCaches } from "@/lib/api-cache";
import {
  IMPORT_TABS,
  IMPORT_TAB_LABELS,
  acceptTopCandidates,
  actionCounts,
  buildImportPreview,
  changedDecisions,
  fieldForColumn,
  formatConfidence,
  importColumns,
  importDataRowCount,
  importMappingError,
  importableCount,
  rowSummary,
  setActionForState,
  setColumnField,
  setRowDecision,
  setStatusChoice,
  sortedTabRows,
  tabCounts,
  undecidedStatusCount,
  type ImportPreview,
  type ImportTab,
} from "@/lib/polish-import";
import { pickImportFile } from "@/lib/read-import-file";
import { useTheme } from "@/theme/theme";

type Step = "pick" | "reading" | "mapping" | "matching" | "review" | "committing" | "summary";

/** CSV import wizard (#109): pick a file → map columns → review matches → commit → summary. */
export default function ImportScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { user } = useAuth();
  const scope = user ? String(user.userId) : null;

  const [step, setStep] = useState<Step>("pick");
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [csvText, setCsvText] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [headerRowIndex, setHeaderRowIndex] = useState(-1);
  const [mapping, setMapping] = useState<PolishImportColumnMapping>({});
  const [session, setSession] = useState<PolishImportSession | null>(null);
  const [rows, setRows] = useState<PolishImportRow[]>([]);

  const pick = useCallback(async () => {
    setError(null);
    setStep("reading");
    try {
      const file = await pickImportFile();
      if (!file) {
        setStep("pick");
        return;
      }
      // Let the "Reading" state paint before the synchronous parse of a big sheet.
      await new Promise((resolve) => setTimeout(resolve, 30));
      const built = buildImportPreview(file.text);
      if (built.records.length === 0) throw new Error("That file has no rows.");
      setFileName(file.name);
      setCsvText(file.text);
      setPreview(built);
      setHeaderRowIndex(built.headerRowIndex);
      setMapping(built.mapping);
      setStep("mapping");
    } catch (err) {
      setError(errorMessage(err, "Couldn't read that file."));
      setStep("pick");
    }
  }, []);

  const startOver = useCallback(() => {
    setStep("pick");
    setError(null);
    setPreview(null);
    setSession(null);
    setRows([]);
    setCsvText("");
    setFileName(null);
  }, []);

  const upload = useCallback(async () => {
    setStep("matching");
    setError(null);
    try {
      const created = await createPolishImport({ csv: csvText, fileName: fileName ?? undefined, mapping, headerRowIndex });
      setSession(created);
      setRows(created.rows);
      setStep(created.status === "committed" ? "summary" : "review");
    } catch (err) {
      setError(errorMessage(err, "Import failed."));
      setStep("mapping");
    }
  }, [csvText, fileName, mapping, headerRowIndex]);

  const commit = useCallback(async () => {
    if (!session) return;
    setStep("committing");
    setError(null);
    try {
      const response = await commitPolishImport(session.id, changedDecisions(session.rows, rows));
      if (scope) await invalidateInventoryCaches(scope);
      setSession(response.session);
      setRows(response.session.rows);
      setStep("summary");
    } catch (err) {
      setError(errorMessage(err, "Commit failed."));
      setStep("review");
    }
  }, [session, rows, scope]);

  if (step === "pick" || step === "reading") {
    return (
      <ScrollView contentContainerStyle={{ padding: theme.spacing(4), gap: theme.spacing(4) }}>
        <Card>
          <AppText variant="heading">Import from a spreadsheet</AppText>
          <AppText muted>
            Export your list from a spreadsheet as CSV (comma, semicolon or tab separated, up to 1 MB and 1000 rows), then pick it here. A SwatchWatch
            export re-imports without changes.
          </AppText>
          <Button title="Choose a CSV file" onPress={() => void pick()} loading={step === "reading"} testID="import-pick" />
        </Card>
        {error ? <ErrorBanner message={error} /> : null}
      </ScrollView>
    );
  }

  if (step === "mapping" && preview) {
    return (
      <MappingStep
        fileName={fileName}
        preview={preview}
        headerRowIndex={headerRowIndex}
        mapping={mapping}
        error={error}
        onMapping={setMapping}
        onHeaderRow={(index) => {
          setHeaderRowIndex(index);
          setMapping(index === preview.headerRowIndex ? preview.mapping : {});
        }}
        onBack={startOver}
        onContinue={() => void upload()}
      />
    );
  }

  if (step === "matching" || step === "committing") {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: theme.spacing(8), gap: theme.spacing(3) }}>
        <ActivityIndicator color={theme.colors.primary} />
        <AppText variant="heading">{step === "matching" ? "Matching to the catalog…" : "Adding to your collection…"}</AppText>
        <AppText muted style={{ textAlign: "center" }}>
          {step === "matching" ? "Large sheets take a little while. Keep the app open." : "Keep the app open until this finishes."}
        </AppText>
      </View>
    );
  }

  if (step === "review" && session) {
    return <ReviewStep rows={rows} error={error} onRows={setRows} onCommit={() => void commit()} onCancel={startOver} />;
  }

  if (step === "summary" && session) {
    const result = session.result;
    return (
      <ScrollView contentContainerStyle={{ padding: theme.spacing(4), gap: theme.spacing(4) }}>
        <Card>
          <AppText variant="heading">Import finished</AppText>
          {result ? (
            <View style={{ gap: theme.spacing(1) }}>
              <SummaryLine label="Added" value={result.created} />
              <SummaryLine label="Updated" value={result.updated} />
              <SummaryLine label="Skipped" value={result.skipped} />
              {result.failed > 0 ? <SummaryLine label="Failed" value={result.failed} /> : null}
              {result.shadesCreated > 0 ? <SummaryLine label="New private shades" value={result.shadesCreated} /> : null}
            </View>
          ) : (
            <AppText muted>This import was already committed.</AppText>
          )}
          <AppText variant="small" muted>
            Importing the same sheet again updates these polishes instead of adding duplicates.
          </AppText>
        </Card>
        <Button title="Open my collection" onPress={() => router.replace("/")} testID="import-done" />
        <Button title="Import another file" variant="outline" onPress={startOver} />
      </ScrollView>
    );
  }

  return null;
}

function SummaryLine({ label, value }: { label: string; value: number }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
      <AppText>{label}</AppText>
      <AppText style={{ fontWeight: "700" }}>{value}</AppText>
    </View>
  );
}

// ── Step 2: column mapping ──────────────────────────────────────────────────

function MappingStep({
  fileName,
  preview,
  headerRowIndex,
  mapping,
  error,
  onMapping,
  onHeaderRow,
  onBack,
  onContinue,
}: {
  fileName: string | null;
  preview: ImportPreview;
  headerRowIndex: number;
  mapping: PolishImportColumnMapping;
  error: string | null;
  onMapping: (mapping: PolishImportColumnMapping) => void;
  onHeaderRow: (index: number) => void;
  onBack: () => void;
  onContinue: () => void;
}) {
  const theme = useTheme();
  const columns = useMemo(() => importColumns(preview, headerRowIndex), [preview, headerRowIndex]);
  const dataRows = importDataRowCount(preview, headerRowIndex);
  const problem = importMappingError(mapping, preview.columnCount, dataRows);
  const [openColumn, setOpenColumn] = useState<number | null>(null);

  return (
    <ScrollView contentContainerStyle={{ padding: theme.spacing(4), gap: theme.spacing(4) }}>
      <Card>
        <AppText variant="heading">Match your columns</AppText>
        <AppText muted>
          {fileName ?? "Your file"}: {dataRows} {dataRows === 1 ? "row" : "rows"}, {preview.columnCount} columns
          {headerRowIndex < 0 ? ", no header row" : ""}.
        </AppText>
        {!preview.confident ? (
          <AppText variant="small" style={{ color: theme.colors.warning }}>
            We weren&apos;t sure about this header. Check each column below.
          </AppText>
        ) : null}
        <View style={{ flexDirection: "row", gap: theme.spacing(2), flexWrap: "wrap" }}>
          <Chip label="Header in first row" selected={headerRowIndex === 0} onPress={() => onHeaderRow(0)} />
          <Chip label="No header" selected={headerRowIndex < 0} onPress={() => onHeaderRow(-1)} />
          {preview.headerRowIndex > 0 ? (
            <Chip
              label={`Detected (row ${preview.headerRowIndex + 1})`}
              selected={headerRowIndex === preview.headerRowIndex}
              onPress={() => onHeaderRow(preview.headerRowIndex)}
            />
          ) : null}
        </View>
      </Card>

      {columns.map((column) => {
        const field = fieldForColumn(mapping, column.index);
        const open = openColumn === column.index;
        return (
          <Card key={column.index} style={{ gap: theme.spacing(2) }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Column ${column.label}: ${field ? POLISH_IMPORT_FIELD_LABELS[field] : "not imported"}`}
              onPress={() => setOpenColumn(open ? null : column.index)}
            >
              <AppText style={{ fontWeight: "700" }}>{column.label}</AppText>
              {column.samples.length > 0 ? (
                <AppText variant="small" muted numberOfLines={1}>
                  {column.samples.join(" · ")}
                </AppText>
              ) : null}
              <AppText variant="small" style={{ color: field ? theme.colors.primary : theme.colors.mutedForeground, marginTop: 4 }}>
                {field ? `→ ${POLISH_IMPORT_FIELD_LABELS[field]}` : "Not imported"} {open ? "▲" : "▼"}
              </AppText>
            </Pressable>
            {open ? (
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.spacing(2) }}>
                <Chip
                  label="Not imported"
                  selected={field === null}
                  onPress={() => {
                    onMapping(setColumnField(mapping, column.index, null));
                    setOpenColumn(null);
                  }}
                />
                {POLISH_IMPORT_FIELDS.map((candidate) => (
                  <Chip
                    key={candidate}
                    label={POLISH_IMPORT_FIELD_LABELS[candidate] + (POLISH_IMPORT_REQUIRED_FIELDS.includes(candidate) ? " *" : "")}
                    selected={field === candidate}
                    onPress={() => {
                      onMapping(setColumnField(mapping, column.index, candidate));
                      setOpenColumn(null);
                    }}
                  />
                ))}
              </View>
            ) : null}
          </Card>
        );
      })}

      {problem ? <ErrorBanner message={problem} /> : null}
      {error ? <ErrorBanner message={error} /> : null}
      <Button title="Match to the catalog" onPress={onContinue} disabled={Boolean(problem)} testID="import-match" />
      <Button title="Choose another file" variant="outline" onPress={onBack} />
    </ScrollView>
  );
}

// ── Step 3: review ──────────────────────────────────────────────────────────

function ReviewStep({
  rows,
  error,
  onRows,
  onCommit,
  onCancel,
}: {
  rows: PolishImportRow[];
  error: string | null;
  onRows: (rows: PolishImportRow[]) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const theme = useTheme();
  const counts = useMemo(() => tabCounts(rows), [rows]);
  const initialTab = IMPORT_TABS.find((tab) => tab !== "invalid" && counts[tab] > 0 && tab !== "matched") ?? "matched";
  const [tab, setTab] = useState<ImportTab>(initialTab);
  const tabRows = useMemo(() => sortedTabRows(rows, tab), [rows, tab]);
  const actions = useMemo(() => actionCounts(rows), [rows]);
  const undecided = useMemo(() => undecidedStatusCount(rows), [rows]);
  const importable = useMemo(() => importableCount(rows), [rows]);
  const pending = actions.pending - counts.invalid;

  const decide = useCallback(
    (rowNumber: number, action: PolishImportAction, shadeId?: string | null) => onRows(setRowDecision(rows, rowNumber, action, shadeId)),
    [rows, onRows],
  );
  const chooseStatus = useCallback(
    (rowNumber: number, choice: PolishImportStatusChoice, reason?: ArchiveReason) => onRows(setStatusChoice(rows, choice, reason, rowNumber)),
    [rows, onRows],
  );

  const header = (
    <View style={{ gap: theme.spacing(3), paddingBottom: theme.spacing(3) }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.spacing(2) }}>
        {IMPORT_TABS.map((t) => (
          <Chip key={t} label={`${IMPORT_TAB_LABELS[t]} ${counts[t]}`} selected={tab === t} onPress={() => setTab(t)} />
        ))}
      </View>
      {tab === "ambiguous" && counts.ambiguous > 0 ? (
        <Button title="Use the best match for all" variant="outline" compact onPress={() => onRows(acceptTopCandidates(rows))} />
      ) : null}
      {tab === "unmatched" && counts.unmatched > 0 ? (
        <View style={{ flexDirection: "row", gap: theme.spacing(2) }}>
          <Button title="Add all as private" variant="outline" compact onPress={() => onRows(setActionForState(rows, "unmatched", "create"))} />
          <Button title="Skip all" variant="outline" compact onPress={() => onRows(setActionForState(rows, "unmatched", "skip"))} />
        </View>
      ) : null}
      {undecided > 0 ? (
        <Card>
          <AppText style={{ fontWeight: "700" }}>
            {undecided} {undecided === 1 ? "row has" : "rows have"} quantity 0
          </AppText>
          <AppText variant="small" muted>
            Is each one on your wishlist or used up? Undecided rows are skipped.
          </AppText>
          <View style={{ flexDirection: "row", gap: theme.spacing(2), flexWrap: "wrap" }}>
            <Button title="All wishlist" variant="outline" compact onPress={() => onRows(setStatusChoice(rows, "wishlist"))} />
            <Button title="All used up" variant="outline" compact onPress={() => onRows(setStatusChoice(rows, "archived", "used_up"))} />
          </View>
        </Card>
      ) : null}
    </View>
  );

  return (
    <View style={{ flex: 1 }}>
      <FlatList
        data={tabRows}
        keyExtractor={(row) => String(row.rowNumber)}
        contentContainerStyle={{ padding: theme.spacing(4), gap: theme.spacing(3) }}
        ListHeaderComponent={header}
        ListEmptyComponent={<AppText muted>Nothing here.</AppText>}
        initialNumToRender={8}
        windowSize={7}
        renderItem={({ item }) => <ReviewRow row={item} onDecide={decide} onStatus={chooseStatus} />}
      />
      <View
        style={{
          padding: theme.spacing(4),
          gap: theme.spacing(2),
          borderTopWidth: 1,
          borderTopColor: theme.colors.border,
          backgroundColor: theme.colors.card,
        }}
      >
        {error ? <ErrorBanner message={error} /> : null}
        <AppText variant="small" muted>
          {importable} will be imported{pending > 0 ? `, ${pending} still undecided (skipped)` : ""}
          {undecided > 0 ? `, ${undecided} need wishlist or used up` : ""}.
        </AppText>
        <Button title={`Import ${importable} polishes`} onPress={onCommit} disabled={importable === 0} testID="import-commit" />
        <Button title="Cancel" variant="ghost" compact onPress={onCancel} />
      </View>
    </View>
  );
}

const ReviewRow = memo(function ReviewRow({
  row,
  onDecide,
  onStatus,
}: {
  row: PolishImportRow;
  onDecide: (rowNumber: number, action: PolishImportAction, shadeId?: string | null) => void;
  onStatus: (rowNumber: number, choice: PolishImportStatusChoice, reason?: ArchiveReason) => void;
}) {
  const theme = useTheme();
  const needsStatus = row.matchState !== "invalid" && row.action !== "skip" && importRowNeedsStatus(row.values);
  return (
    <Card style={{ gap: theme.spacing(2) }}>
      <AppText variant="tiny" muted>
        Row {row.rowNumber}
      </AppText>
      <AppText style={{ fontWeight: "700" }}>{rowSummary(row)}</AppText>

      {row.matchState === "invalid" ? (
        <AppText variant="small" style={{ color: theme.colors.destructive }}>
          {row.errors.join(" ") || "This row can't be imported."}
        </AppText>
      ) : (
        <>
          {row.matchState !== "unmatched"
            ? row.candidates.map((candidate) => {
                const active = row.action === "match" && row.shadeId === candidate.shadeId;
                return (
                  <Pressable
                    key={candidate.shadeId}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    accessibilityLabel={`${candidate.brand} ${candidate.name}, ${formatConfidence(candidate.confidence)} match`}
                    onPress={() => onDecide(row.rowNumber, "match", candidate.shadeId)}
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: theme.spacing(3),
                      padding: theme.spacing(2),
                      borderRadius: theme.radius.lg,
                      borderWidth: active ? 2 : 1,
                      borderColor: active ? theme.colors.primary : theme.colors.border,
                    }}
                  >
                    <Swatch hex={candidate.hex} size={36} />
                    <View style={{ flex: 1 }}>
                      <AppText numberOfLines={1}>{candidate.name}</AppText>
                      <AppText variant="small" muted numberOfLines={1}>
                        {candidate.brand} · {formatConfidence(candidate.confidence)}
                        {candidate.inCollection ? " · in your collection" : ""}
                      </AppText>
                    </View>
                  </Pressable>
                );
              })
            : (
              <AppText variant="small" muted>
                Not in the catalog.
              </AppText>
            )}
          <View style={{ flexDirection: "row", gap: theme.spacing(2), flexWrap: "wrap" }}>
            <Chip label="Add as private shade" selected={row.action === "create"} onPress={() => onDecide(row.rowNumber, "create")} />
            <Chip label="Skip" selected={row.action === "skip"} onPress={() => onDecide(row.rowNumber, "skip")} />
          </View>
          {needsStatus ? (
            <View style={{ gap: theme.spacing(1) }}>
              <AppText variant="small" muted>
                Quantity 0: wishlist or used up?
              </AppText>
              <View style={{ flexDirection: "row", gap: theme.spacing(2), flexWrap: "wrap" }}>
                <Chip label="Wishlist" selected={row.statusChoice === "wishlist"} onPress={() => onStatus(row.rowNumber, "wishlist")} />
                <Chip
                  label="Used up"
                  selected={row.statusChoice === "archived" && (row.archiveReason ?? "used_up") === "used_up"}
                  onPress={() => onStatus(row.rowNumber, "archived", "used_up")}
                />
                <Chip
                  label="Decluttered"
                  selected={row.statusChoice === "archived" && row.archiveReason === "decluttered"}
                  onPress={() => onStatus(row.rowNumber, "archived", "decluttered")}
                />
              </View>
            </View>
          ) : null}
          {row.warnings.length > 0 ? (
            <AppText variant="tiny" muted>
              {row.warnings.join(" ")}
            </AppText>
          ) : null}
        </>
      )}
    </Card>
  );
});
