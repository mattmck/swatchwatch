"use client";

import { useEffect, useRef, useState } from "react";
import {
  POLISH_IMPORT_FIELDS,
  POLISH_IMPORT_FIELD_LABELS,
  POLISH_IMPORT_MAX_BYTES,
  POLISH_IMPORT_MAX_ROWS,
  type CatalogSearchResult,
  type PolishImportCandidate,
  type PolishImportColumnMapping,
  type PolishImportField,
  type PolishImportRow,
} from "swatchwatch-shared";
import { AlertTriangle, CheckCircle2, FileSpreadsheet, Search, Upload } from "lucide-react";
import { searchCatalog } from "@/lib/api";
import {
  IMPORT_ACCEPT,
  decisionValue,
  fieldForColumn,
  formatConfidence,
  parseDecisionValue,
  type ImportColumn,
} from "@/lib/polish-import";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ColorDot } from "@/components/color-dot";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

const SAMPLE_CSV =
  "Brand,Shade Name,Finish,Qty,Price,Currency,Purchase Date,Status,Tried,Notes\n" +
  'Essie,Ballet Slippers,sheer,1,9.50,USD,2026-03-15,owned,yes,"Classic, two coats"\n' +
  "Holo Taco,One Coat Black,creme,1,,,,wishlist,,\n";

// ── Upload ───────────────────────────────────────────────────────────────────

export function CsvDropZone({ onFile, disabled = false }: { onFile: (file: File) => void; disabled?: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const handleFiles = (files: FileList | null) => {
    const file = files?.[0];
    if (file) onFile(file);
  };

  return (
    <div
      onDragOver={(event) => {
        event.preventDefault();
        if (!disabled) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        if (!disabled) handleFiles(event.dataTransfer.files);
      }}
      className={cn(
        "flex min-h-[240px] flex-col items-center justify-center gap-4 rounded-2xl border-2 border-dashed px-6 py-10 text-center transition-colors",
        dragging
          ? "border-brand-purple bg-brand-pink-light/40 dark:bg-brand-purple/20"
          : "border-brand-purple/25 bg-muted/30",
      )}
    >
      <div className="inline-flex size-14 items-center justify-center rounded-full bg-gradient-brand-soft shadow-glow-brand">
        <FileSpreadsheet className="size-6 text-brand-purple-deep dark:text-brand-lilac" aria-hidden="true" />
      </div>
      <div>
        <p className="font-semibold">Drop a CSV file here</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Export your spreadsheet as CSV (Google Sheets, Excel and Numbers all can). Up to{" "}
          {POLISH_IMPORT_MAX_ROWS.toLocaleString()} rows, {POLISH_IMPORT_MAX_BYTES / 1024 / 1024} MB.
        </p>
      </div>
      <Button
        type="button"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        className="bg-gradient-brand text-white shadow-glow-brand hover:opacity-90"
      >
        <Upload aria-hidden="true" />
        Choose file
      </Button>
      <input
        ref={inputRef}
        type="file"
        accept={IMPORT_ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          handleFiles(event.target.files);
          event.target.value = "";
        }}
      />
      <p className="text-xs text-muted-foreground">
        Columns we look for: brand, shade name, finish, quantity, price, currency, purchase date, status, tried, notes.{" "}
        <a
          className="underline underline-offset-2"
          href={`data:text/csv;charset=utf-8,${encodeURIComponent(SAMPLE_CSV)}`}
          download="swatchwatch-import-template.csv"
        >
          Download a template
        </a>
      </p>
    </div>
  );
}

// ── Column mapping ───────────────────────────────────────────────────────────

const IGNORE = "__ignore";
const NO_HEADER = "-1";

export function ColumnMappingTable({
  columns,
  mapping,
  onChange,
}: {
  columns: ImportColumn[];
  mapping: PolishImportColumnMapping;
  onChange: (column: number, field: PolishImportField | null) => void;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Column</TableHead>
          <TableHead>Sample values</TableHead>
          <TableHead className="w-[200px]">Import as</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {columns.map((column) => {
          const field = fieldForColumn(mapping, column.index);
          return (
            <TableRow key={column.index}>
              <TableCell className="font-medium">{column.label}</TableCell>
              <TableCell className="max-w-[320px] truncate text-sm text-muted-foreground">
                {column.samples.length ? column.samples.join(" · ") : <span className="italic">empty</span>}
              </TableCell>
              <TableCell>
                <Select
                  value={field ?? IGNORE}
                  onValueChange={(value) => onChange(column.index, value === IGNORE ? null : (value as PolishImportField))}
                >
                  <SelectTrigger className="h-8 w-[190px]" aria-label={`Import ${column.label} as`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={IGNORE}>Don&apos;t import</SelectItem>
                    <SelectSeparator />
                    {POLISH_IMPORT_FIELDS.map((option) => (
                      <SelectItem key={option} value={option}>
                        {POLISH_IMPORT_FIELD_LABELS[option]}
                        {option === "brand" || option === "name" ? " *" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

export function HeaderRowSelect({
  records,
  value,
  onChange,
}: {
  records: string[][];
  value: number;
  onChange: (value: number) => void;
}) {
  const options = records.slice(0, 10);
  return (
    <Select value={String(value)} onValueChange={(next) => onChange(Number(next))}>
      <SelectTrigger className="h-8 w-full max-w-md" aria-label="Header row">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NO_HEADER}>No header row (first row is data)</SelectItem>
        {options.map((record, index) => (
          <SelectItem key={index} value={String(index)}>
            Row {index + 1}: {record.filter((cell) => cell.trim()).slice(0, 4).join(", ").slice(0, 60) || "(blank)"}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// ── Review ───────────────────────────────────────────────────────────────────

function CandidateLabel({ candidate }: { candidate: PolishImportCandidate }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <ColorDot hex={candidate.hex ?? undefined} size="sm" className="shrink-0" />
      <span className="truncate">
        {candidate.brand} — {candidate.name}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">{formatConfidence(candidate.confidence)}</span>
      {candidate.inCollection && (
        <Badge variant="secondary" className="shrink-0 text-[10px]">
          in collection
        </Badge>
      )}
      {candidate.userSubmitted && (
        <Badge variant="outline" className="shrink-0 text-[10px]">
          private
        </Badge>
      )}
    </span>
  );
}

const STATE_BADGE: Record<PolishImportRow["matchState"], string> = {
  matched:
    "border border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200",
  ambiguous:
    "border border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-200",
  unmatched:
    "border border-neutral-300 bg-neutral-50 text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300",
  invalid: "border border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/60 dark:text-red-200",
};

function rowDetails(row: PolishImportRow): string {
  const v = row.values;
  const parts: string[] = [];
  if (v.finishes.length) parts.push(v.finishes.join(" / "));
  if (v.quantity !== undefined) parts.push(`qty ${v.quantity}`);
  if (v.status) parts.push(v.status);
  if (v.purchasePrice !== undefined) parts.push(`${v.purchasePrice}${v.purchaseCurrency ? ` ${v.purchaseCurrency}` : ""}`);
  if (v.purchaseDate) parts.push(v.purchaseDate);
  if (v.tried !== undefined) parts.push(v.tried ? `tried${v.triedOn ? ` ${v.triedOn}` : ""}` : "untried");
  return parts.join(" · ");
}

export function ReviewTable({
  rows,
  readOnly,
  onDecision,
  onSearch,
}: {
  rows: PolishImportRow[];
  readOnly: boolean;
  onDecision: (rowNumber: number, action: PolishImportRow["action"], shadeId?: string) => void;
  onSearch: (row: PolishImportRow) => void;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[64px]">Row</TableHead>
          <TableHead>From your sheet</TableHead>
          <TableHead className="min-w-[320px]">Import as</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.rowNumber} className="align-top">
            <TableCell className="text-muted-foreground">{row.rowNumber}</TableCell>
            <TableCell className="max-w-[360px] whitespace-normal">
              <div className="font-medium">
                {row.values.brand || <span className="italic text-muted-foreground">no brand</span>} ·{" "}
                {row.values.name || <span className="italic text-muted-foreground">no name</span>}
              </div>
              <div className="text-xs text-muted-foreground">{rowDetails(row)}</div>
              {[...row.errors, ...row.warnings].map((message) => (
                <div key={message} className="mt-1 flex items-start gap-1 text-xs text-amber-700 dark:text-amber-300">
                  <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                  {message}
                </div>
              ))}
            </TableCell>
            <TableCell className="whitespace-normal">
              {row.matchState === "invalid" ? (
                <span className="text-sm text-muted-foreground">Skipped</span>
              ) : readOnly ? (
                <OutcomeCell row={row} />
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <Select
                    value={row.action === "pending" ? "" : decisionValue(row)}
                    onValueChange={(value) => {
                      const { action, shadeId } = parseDecisionValue(value);
                      onDecision(row.rowNumber, action, shadeId);
                    }}
                  >
                    <SelectTrigger
                      className={cn("h-auto min-h-8 w-full max-w-[420px] py-1", row.action === "pending" && "border-amber-400")}
                      aria-label={`Decision for row ${row.rowNumber}`}
                    >
                      <SelectValue placeholder="Choose a match…" />
                    </SelectTrigger>
                    <SelectContent>
                      {row.candidates.map((candidate) => (
                        <SelectItem key={candidate.shadeId} value={`match:${candidate.shadeId}`}>
                          <CandidateLabel candidate={candidate} />
                        </SelectItem>
                      ))}
                      {row.candidates.length > 0 && <SelectSeparator />}
                      <SelectItem value="create">Add as a new private shade</SelectItem>
                      <SelectItem value="skip">Skip this row</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button type="button" variant="ghost" size="sm" onClick={() => onSearch(row)}>
                    <Search aria-hidden="true" />
                    Search
                  </Button>
                  <Badge className={cn("text-[10px]", STATE_BADGE[row.matchState])}>
                    {row.candidates[0] ? formatConfidence(row.confidence) : "no match"}
                  </Badge>
                </div>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function OutcomeCell({ row }: { row: PolishImportRow }) {
  const candidate = row.candidates.find((c) => c.shadeId === row.shadeId);
  const tone =
    row.outcome === "failed"
      ? "text-red-700 dark:text-red-300"
      : row.outcome === "skipped"
        ? "text-muted-foreground"
        : "text-emerald-700 dark:text-emerald-300";
  return (
    <div className="space-y-1 text-sm">
      {candidate && <CandidateLabel candidate={candidate} />}
      <div className={tone}>
        {row.outcome ?? row.action}
        {row.outcomeMessage ? ` — ${row.outcomeMessage}` : ""}
      </div>
    </div>
  );
}

// ── Catalog search (re-match) ────────────────────────────────────────────────

export function CatalogSearchDialog({
  row,
  onClose,
  onPick,
}: {
  row: PolishImportRow | null;
  onClose: () => void;
  onPick: (row: PolishImportRow, result: CatalogSearchResult) => void;
}) {
  return (
    <Dialog open={row !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Find the right polish</DialogTitle>
          <DialogDescription>
            Row {row?.rowNumber}: {row?.values.brand} · {row?.values.name}
          </DialogDescription>
        </DialogHeader>
        {row && <CatalogSearchBody key={row.rowNumber} row={row} onPick={onPick} />}
      </DialogContent>
    </Dialog>
  );
}

function CatalogSearchBody({
  row,
  onPick,
}: {
  row: PolishImportRow;
  onPick: (row: PolishImportRow, result: CatalogSearchResult) => void;
}) {
  const [query, setQuery] = useState(`${row.values.brand} ${row.values.name}`.trim());
  const [results, setResults] = useState<CatalogSearchResult[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      setStatus("loading");
      try {
        const response = await searchCatalog(q, 10);
        if (!cancelled) {
          setResults(response.results);
          setStatus("idle");
        }
      } catch {
        if (!cancelled) setStatus("error");
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  return (
    <>
      <Input
        autoFocus
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search brand or shade name"
        aria-label="Search the catalog"
      />
      <div className="max-h-72 space-y-1 overflow-y-auto">
        {status === "loading" && <p className="py-4 text-center text-sm text-muted-foreground">Searching…</p>}
        {status === "error" && <p className="py-4 text-center text-sm text-red-600">Search failed. Try again.</p>}
        {status === "idle" && results.length === 0 && query.trim().length >= 2 && (
          <p className="py-4 text-center text-sm text-muted-foreground">No catalog matches yet.</p>
        )}
        {results.map((result) => (
          <button
            key={result.shadeId}
            type="button"
            className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-muted"
            onClick={() => onPick(row, result)}
          >
            <span className="truncate">
              {result.brand} — {result.name}
              {result.finishes?.length ? (
                <span className="text-muted-foreground"> · {result.finishes.join(" / ")}</span>
              ) : null}
            </span>
            <CheckCircle2 className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          </button>
        ))}
      </div>
    </>
  );
}
