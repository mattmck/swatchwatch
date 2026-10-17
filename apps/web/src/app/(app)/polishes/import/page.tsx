"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type {
  ArchiveReason,
  CatalogSearchResult,
  PolishImportColumnMapping,
  PolishImportField,
  PolishImportRow,
  PolishImportSession,
  PolishImportStatusChoice,
} from "swatchwatch-shared";
import { ArrowLeft, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { ARCHIVE_REASON_LABELS } from "swatchwatch-shared";
import { commitPolishImport, createPolishImport, getPolishImport } from "@/lib/api";
import {
  IMPORT_TABS,
  IMPORT_TAB_LABELS,
  acceptTopCandidates,
  actionCounts,
  buildImportPreview,
  changedDecisions,
  checkImportFile,
  importColumns,
  importDataRowCount,
  importMappingError,
  importableCount,
  pickSearchResult,
  rowsForTab,
  rowsNeedingStatus,
  setActionForState,
  setColumnField,
  setRowDecision,
  setStatusChoice,
  tabCounts,
  undecidedStatusCount,
  type ImportPreview,
  type ImportTab,
} from "@/lib/polish-import";
import { BrandSpinner } from "@/components/brand-spinner";
import { ErrorState } from "@/components/error-state";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  CatalogSearchDialog,
  ColumnMappingTable,
  CsvDropZone,
  HeaderRowSelect,
  ReviewTable,
} from "./import-components";
import { cn } from "@/lib/utils";

type Step = "upload" | "mapping" | "matching" | "review" | "committing" | "summary";
const ROWS_PER_PAGE = 100;

export default function PolishImportPage() {
  return (
    <Suspense fallback={<BrandSpinner label="Loading import…" />}>
      <PolishImportWizard />
    </Suspense>
  );
}

/**
 * CSV import wizard: upload → column mapping → review (matched / needs review / not in
 * catalog / can't import) → commit → summary. The session id lives in `?session=` so a
 * reload resumes the review.
 */
function PolishImportWizard() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const sessionParam = searchParams.get("session");

  const [step, setStep] = useState<Step>(sessionParam ? "matching" : "upload");
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [csvText, setCsvText] = useState<string>("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [headerRowIndex, setHeaderRowIndex] = useState(-1);
  const [mapping, setMapping] = useState<PolishImportColumnMapping>({});
  const [session, setSession] = useState<PolishImportSession | null>(null);
  const [rows, setRows] = useState<PolishImportRow[]>([]);
  const [tab, setTab] = useState<ImportTab>("ambiguous");
  const [visible, setVisible] = useState(ROWS_PER_PAGE);
  const [searchRow, setSearchRow] = useState<PolishImportRow | null>(null);
  const [bulkArchiveReason, setBulkArchiveReason] = useState<ArchiveReason>("used_up");
  const loadedSessionRef = useRef<string | null>(null);

  const showSession = useCallback((loaded: PolishImportSession) => {
    setSession(loaded);
    setRows(loaded.rows);
    setFileName(loaded.fileName);
    const counts = tabCounts(loaded.rows);
    setTab(counts.ambiguous ? "ambiguous" : counts.unmatched ? "unmatched" : "matched");
    setVisible(ROWS_PER_PAGE);
    setStep(loaded.status === "committed" ? "summary" : "review");
  }, []);

  // Resume a session from the URL (reload / shared link to your own import).
  useEffect(() => {
    if (!sessionParam || loadedSessionRef.current === sessionParam) return;
    loadedSessionRef.current = sessionParam;
    let cancelled = false;
    getPolishImport(sessionParam)
      .then((loaded) => {
        if (!cancelled) showSession(loaded);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Couldn't load that import");
        setStep("upload");
        router.replace(pathname);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionParam, pathname, router, showSession]);

  const reset = useCallback(() => {
    loadedSessionRef.current = null;
    setStep("upload");
    setError(null);
    setPreview(null);
    setCsvText("");
    setSession(null);
    setRows([]);
    router.replace(pathname);
  }, [pathname, router]);

  const handleFile = useCallback(async (file: File) => {
    setError(null);
    const problem = checkImportFile(file);
    if (problem) {
      setError(problem);
      return;
    }
    try {
      const text = await file.text();
      const built = buildImportPreview(text);
      if (built.records.length === 0) {
        setError("That file has no rows.");
        return;
      }
      setFileName(file.name);
      setCsvText(text);
      setPreview(built);
      setHeaderRowIndex(built.headerRowIndex);
      setMapping(built.mapping);
      setStep("mapping");
    } catch {
      setError("Couldn't read that file. Is it a text CSV?");
    }
  }, []);

  const columns = useMemo(
    () => (preview ? importColumns(preview, headerRowIndex) : []),
    [preview, headerRowIndex]
  );
  const dataRows = preview ? importDataRowCount(preview, headerRowIndex) : 0;
  const mappingProblem = preview ? importMappingError(mapping, preview.columnCount, dataRows) : null;

  const upload = useCallback(async () => {
    setStep("matching");
    setError(null);
    try {
      const created = await createPolishImport({
        csv: csvText,
        fileName: fileName ?? undefined,
        mapping,
        headerRowIndex,
      });
      loadedSessionRef.current = created.id;
      showSession(created);
      router.replace(`${pathname}?session=${created.id}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Import failed");
      setStep("mapping");
    }
  }, [csvText, fileName, mapping, headerRowIndex, pathname, router, showSession]);

  const commit = useCallback(async () => {
    if (!session) return;
    setStep("committing");
    setError(null);
    try {
      const response = await commitPolishImport(session.id, changedDecisions(session.rows, rows));
      showSession(response.session);
      toast.success(
        `Imported ${response.result.created + response.result.updated} polishes (${response.result.created} new, ${response.result.updated} updated)`
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Commit failed");
      setStep("review");
    }
  }, [session, rows, showSession]);

  const counts = useMemo(() => tabCounts(rows), [rows]);
  const actions = useMemo(() => actionCounts(rows), [rows]);
  const tabRows = useMemo(() => rowsForTab(rows, tab), [rows, tab]);
  const statusRows = useMemo(() => rowsNeedingStatus(rows).length, [rows]);
  const statusUndecided = useMemo(() => undecidedStatusCount(rows), [rows]);
  const importable = useMemo(() => importableCount(rows), [rows]);

  const onDecision = useCallback((rowNumber: number, action: PolishImportRow["action"], shadeId?: string) => {
    setRows((current) => setRowDecision(current, rowNumber, action, shadeId));
  }, []);
  const onStatusChoice = useCallback((rowNumber: number, choice: PolishImportStatusChoice, reason?: ArchiveReason) => {
    setRows((current) => setStatusChoice(current, choice, reason, rowNumber));
  }, []);
  const onPick = useCallback((row: PolishImportRow, result: CatalogSearchResult) => {
    setRows((current) => pickSearchResult(current, row.rowNumber, result));
    setSearchRow(null);
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="heading-page">Import from Spreadsheet</h1>
          <p className="text-muted-foreground">
            Bring your collection over from a CSV. Re-importing the same sheet updates polishes instead of
            duplicating them.
          </p>
        </div>
        <Button asChild variant="outline">
          <Link href="/polishes">
            <ArrowLeft aria-hidden="true" />
            Back to polishes
          </Link>
        </Button>
      </div>

      <StepIndicator step={step} />

      {error && step !== "matching" && step !== "committing" && (
        <ErrorState title="Import problem" message={error} className="min-h-0 py-2" />
      )}

      {step === "upload" && <CsvDropZone onFile={handleFile} />}

      {step === "mapping" && preview && (
        <Card>
          <CardHeader>
            <CardTitle>Check your columns</CardTitle>
            <CardDescription>
              {fileName} · {dataRows} rows.{" "}
              {preview.confident && headerRowIndex === preview.headerRowIndex
                ? "We recognized your columns; adjust anything that looks off."
                : "We couldn't recognize every column. Pick what each column holds; brand and shade name are required."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1">
              <p className="text-sm font-medium">Header row</p>
              <HeaderRowSelect records={preview.records} value={headerRowIndex} onChange={setHeaderRowIndex} />
            </div>
            <div className="overflow-x-auto">
              <ColumnMappingTable
                columns={columns}
                mapping={mapping}
                onChange={(column: number, field: PolishImportField | null) =>
                  setMapping((current) => setColumnField(current, column, field))
                }
              />
            </div>
            {mappingProblem && <p className="text-sm text-amber-700 dark:text-amber-300">{mappingProblem}</p>}
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="outline" onClick={reset}>
                Choose another file
              </Button>
              <Button disabled={Boolean(mappingProblem)} onClick={upload}>
                Match {dataRows} rows
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === "matching" && <BrandSpinner label="Matching your polishes to the catalog…" />}
      {step === "committing" && <BrandSpinner label="Adding polishes to your collection…" />}

      {(step === "review" || step === "summary") && session && (
        <Card>
          <CardHeader>
            <CardTitle>{step === "summary" ? "Import complete" : "Review matches"}</CardTitle>
            <CardDescription>
              {session.fileName ?? "Uploaded file"} · {rows.length} rows
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {step === "summary" && session.result && (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <SummaryStat label="Added" value={session.result.created} />
                <SummaryStat label="Updated" value={session.result.updated} />
                <SummaryStat label="Skipped" value={session.result.skipped} />
                <SummaryStat label="Failed" value={session.result.failed} tone={session.result.failed ? "bad" : undefined} />
              </div>
            )}
            {step === "summary" && session.result && session.result.shadesCreated > 0 && (
              <p className="text-sm text-muted-foreground">
                {session.result.shadesCreated} polishes weren&apos;t in the catalog and were added as private shades only
                you can see.
              </p>
            )}

            <div className="flex flex-wrap gap-2" role="tablist" aria-label="Rows by match result">
              {IMPORT_TABS.map((key) => (
                <Button
                  key={key}
                  role="tab"
                  aria-selected={tab === key}
                  variant={tab === key ? "default" : "outline"}
                  size="sm"
                  onClick={() => {
                    setTab(key);
                    setVisible(ROWS_PER_PAGE);
                  }}
                >
                  {IMPORT_TAB_LABELS[key]} ({counts[key]})
                </Button>
              ))}
            </div>

            {step === "review" && statusRows > 0 && (
              <div
                className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-300 bg-amber-50/60 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/30"
                role="group"
                aria-label="Status for rows with quantity 0"
              >
                <p className="mr-auto">
                  {statusRows} {statusRows === 1 ? "row has" : "rows have"} quantity 0 and no status. Do you want
                  {statusRows === 1 ? " it" : " them"}, or did you use {statusRows === 1 ? "it" : "them"} up?
                  {statusUndecided > 0 && (
                    <span className="text-amber-700 dark:text-amber-300"> {statusUndecided} undecided.</span>
                  )}
                </p>
                <Button variant="outline" size="sm" onClick={() => setRows((current) => setStatusChoice(current, "wishlist"))}>
                  Mark as wishlist
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setRows((current) => setStatusChoice(current, "archived", bulkArchiveReason))}
                >
                  Mark as archived
                </Button>
                <div className="flex items-center gap-1" role="radiogroup" aria-label="Archive reason">
                  {(["used_up", "decluttered"] as const).map((reason) => (
                    <Button
                      key={reason}
                      role="radio"
                      aria-checked={bulkArchiveReason === reason}
                      variant={bulkArchiveReason === reason ? "secondary" : "ghost"}
                      size="xs"
                      onClick={() => setBulkArchiveReason(reason)}
                    >
                      {ARCHIVE_REASON_LABELS[reason]}
                    </Button>
                  ))}
                </div>
              </div>
            )}

            {step === "review" && (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                {tab === "ambiguous" && counts.ambiguous > 0 && (
                  <Button variant="outline" size="sm" onClick={() => setRows((current) => acceptTopCandidates(current))}>
                    Accept best match for undecided rows
                  </Button>
                )}
                {tab === "unmatched" && counts.unmatched > 0 && (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setRows((current) => setActionForState(current, "unmatched", "create"))}
                    >
                      Add all as private shades
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setRows((current) => setActionForState(current, "unmatched", "skip"))}
                    >
                      Skip all
                    </Button>
                  </>
                )}
              </div>
            )}

            {tabRows.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">No rows here.</p>
            ) : (
              <div className="overflow-x-auto">
                <ReviewTable
                  rows={tabRows.slice(0, visible)}
                  readOnly={step === "summary"}
                  onDecision={onDecision}
                  onStatusChoice={onStatusChoice}
                  onSearch={setSearchRow}
                />
              </div>
            )}
            {tabRows.length > visible && (
              <div className="flex justify-center">
                <Button variant="ghost" size="sm" onClick={() => setVisible((n) => n + ROWS_PER_PAGE)}>
                  Show {Math.min(ROWS_PER_PAGE, tabRows.length - visible)} more
                </Button>
              </div>
            )}

            {step === "review" ? (
              <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
                <p className="text-sm text-muted-foreground">
                  {actions.match} matched · {actions.create} new private shades · {actions.skip} skipped
                  {actions.pending > 0 && (
                    <span className="text-amber-700 dark:text-amber-300">
                      {" "}
                      · {actions.pending} undecided (will be skipped)
                    </span>
                  )}
                  {statusUndecided > 0 && (
                    <span className="text-amber-700 dark:text-amber-300">
                      {" "}
                      · {statusUndecided} need wishlist or archived (will be skipped)
                    </span>
                  )}
                </p>
                <div className="flex gap-2">
                  <Button variant="outline" onClick={reset}>
                    Start over
                  </Button>
                  <Button disabled={importable === 0} onClick={commit}>
                    Import {importable} polishes
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap justify-end gap-2 border-t pt-4">
                <Button variant="outline" onClick={reset}>
                  Import another file
                </Button>
                <Button asChild>
                  <Link href="/polishes?scope=collection">View my collection</Link>
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <CatalogSearchDialog row={searchRow} onClose={() => setSearchRow(null)} onPick={onPick} />
    </div>
  );
}

const STEPS: Array<{ key: Step[]; label: string }> = [
  { key: ["upload"], label: "Upload" },
  { key: ["mapping"], label: "Columns" },
  { key: ["matching", "review"], label: "Review" },
  { key: ["committing", "summary"], label: "Done" },
];

function StepIndicator({ step }: { step: Step }) {
  const current = STEPS.findIndex((entry) => entry.key.includes(step));
  return (
    <ol className="flex flex-wrap items-center gap-2 text-sm" aria-label="Import steps">
      {STEPS.map((entry, index) => (
        <li
          key={entry.label}
          aria-current={index === current ? "step" : undefined}
          className={cn(
            "flex items-center gap-2 rounded-full border px-3 py-1",
            index === current
              ? "border-brand-purple bg-brand-pink-light/40 font-medium dark:bg-brand-purple/20"
              : index < current
                ? "text-foreground"
                : "text-muted-foreground"
          )}
        >
          {(entry.key.includes("matching") && step === "matching") ||
          (entry.key.includes("committing") && step === "committing") ? (
            <Loader2 className="size-3 animate-spin" aria-hidden="true" />
          ) : null}
          {index + 1}. {entry.label}
        </li>
      ))}
    </ol>
  );
}

function SummaryStat({ label, value, tone }: { label: string; value: number; tone?: "bad" }) {
  return (
    <div className="rounded-xl border bg-muted/30 p-3 text-center">
      <div className={cn("text-2xl font-semibold", tone === "bad" && "text-red-600 dark:text-red-400")}>{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}
