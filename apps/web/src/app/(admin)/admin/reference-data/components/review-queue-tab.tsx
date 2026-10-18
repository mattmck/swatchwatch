"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ShadeReviewApproveRequest,
  ShadeReviewItem,
  ShadeReviewListResponse,
  ShadeReviewMergeCandidate,
  ShadeReviewQueueState,
} from "swatchwatch-shared";
import {
  approveShadeReview,
  getShadeReviewCandidates,
  listShadeReviewQueue,
  mergeShadeReview,
  rejectShadeReview,
} from "@/lib/api";
import { FinishBadges } from "@/components/finish-badges";
import { SwatchThumbnail } from "@/components/swatch-thumbnail";
import { ToggleChip } from "@/components/toggle-chip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useReferenceData } from "@/hooks/use-reference-data";
import { buildFinishOptions } from "@/lib/finish-options";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 25;
const HEX_INPUT_PATTERN = /^#?[0-9a-f]{6}$/i;

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/** Editable fields of the "edit & approve" form; text inputs hold strings ("" = empty). */
export interface ApproveFormState {
  brand: string;
  name: string;
  finishes: string[];
  collection: string;
  colorName: string;
  vendorHex: string;
  nameHex: string;
  note: string;
}

/** Seed the edit form from the submission as it was submitted. */
export function approveFormFromItem(item: ShadeReviewItem): ApproveFormState {
  return {
    brand: item.brand,
    name: item.name,
    finishes: [...item.finishes],
    collection: item.collection ?? "",
    colorName: item.colorName ?? "",
    vendorHex: item.vendorHex ?? "",
    nameHex: item.nameHex ?? "",
    note: "",
  };
}

function normalizeHexInput(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return `#${trimmed.replace(/^#/, "").toUpperCase()}`;
}

/**
 * Validate the edit form. Returns a user-facing error message, or null when it can be sent.
 */
export function validateApproveForm(form: ApproveFormState): string | null {
  if (!form.brand.trim()) return "Brand is required.";
  if (!form.name.trim()) return "Name is required.";
  for (const [label, value] of [["Vendor hex", form.vendorHex], ["Name hex", form.nameHex]] as const) {
    if (value.trim() && !HEX_INPUT_PATTERN.test(value.trim())) {
      return `${label} must be a 6-digit hex color like #C4113C.`;
    }
  }
  return null;
}

/**
 * Build the approve payload: only fields the admin actually changed are sent (unchanged fields
 * keep the submitted value server-side); cleared nullable fields are sent as `null`.
 */
export function buildApprovePayload(item: ShadeReviewItem, form: ApproveFormState): ShadeReviewApproveRequest {
  const payload: ShadeReviewApproveRequest = {};
  const brand = form.brand.trim();
  const name = form.name.trim();
  if (brand && brand !== item.brand) payload.brand = brand;
  if (name && name !== item.name) payload.name = name;
  if (form.finishes.join("|") !== item.finishes.join("|")) payload.finishes = [...form.finishes];

  const nullableText = (value: string) => value.trim() || null;
  if (nullableText(form.collection) !== (item.collection ?? null)) payload.collection = nullableText(form.collection);
  if (nullableText(form.colorName) !== (item.colorName ?? null)) payload.colorName = nullableText(form.colorName);

  const vendorHex = normalizeHexInput(form.vendorHex);
  if (vendorHex !== (item.vendorHex ? normalizeHexInput(item.vendorHex) : null)) payload.vendorHex = vendorHex;
  const nameHex = normalizeHexInput(form.nameHex);
  if (nameHex !== (item.nameHex ? normalizeHexInput(item.nameHex) : null)) payload.nameHex = nameHex;

  const note = form.note.trim();
  if (note) payload.note = note;
  return payload;
}

/** Confirmation text shown before a merge (it moves other users' inventory and cannot be undone). */
export function mergeConfirmationMessage(item: ShadeReviewItem, candidate: ShadeReviewMergeCandidate): string {
  const users = item.submitterCount === 1 ? "1 user's" : `${item.submitterCount} users'`;
  return (
    `Merge "${item.brand} — ${item.name}" (#${item.shadeId}) into "${candidate.brand} — ${candidate.name}" (#${candidate.shadeId})?\n\n` +
    `${users} inventory will move to the catalog shade (duplicates are combined) and the submission is retired. ` +
    "This cannot be undone."
  );
}

/** "86%" for a 0–1 similarity score. */
export function formatSimilarity(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

/** Human label for an OKLAB distance between two display hexes. */
export function describeColorDistance(distance: number | null): string {
  if (distance === null) return "no hex to compare";
  if (distance <= 0.02) return `ΔE ${distance.toFixed(3)} · same color`;
  if (distance <= 0.05) return `ΔE ${distance.toFixed(3)} · very close`;
  if (distance <= 0.1) return `ΔE ${distance.toFixed(3)} · close`;
  return `ΔE ${distance.toFixed(3)} · different`;
}

type ComparableField = "brand" | "name" | "finishes" | "collection" | "colorName" | "vendorHex" | "detectedHex" | "nameHex";

/** One row of the side-by-side comparison table. */
export interface ComparisonRow {
  field: ComparableField;
  label: string;
  submission: string;
  candidate: string;
  differs: boolean;
}

function comparableValue(value: string | readonly string[] | null | undefined): string {
  if (Array.isArray(value)) return value.join(", ");
  return (value as string | null | undefined)?.trim() ?? "";
}

/** Field-by-field comparison of a submission and a merge candidate (case-insensitive diff). */
export function buildComparisonRows(item: ShadeReviewItem, candidate: ShadeReviewMergeCandidate | null): ComparisonRow[] {
  const fields: Array<[ComparableField, string]> = [
    ["brand", "Brand"],
    ["name", "Name"],
    ["finishes", "Finishes"],
    ["collection", "Collection"],
    ["colorName", "Color name"],
    ["vendorHex", "Vendor hex"],
    ["detectedHex", "Detected hex"],
    ["nameHex", "Name hex"],
  ];
  return fields.map(([field, label]) => {
    const submission = comparableValue(item[field]);
    const other = candidate ? comparableValue(candidate[field]) : "";
    return {
      field,
      label,
      submission,
      candidate: other,
      differs: Boolean(candidate) && submission.toLowerCase() !== other.toLowerCase(),
    };
  });
}

/**
 * Fetch one page of the queue and update state holders (guarded against unmounts).
 */
export async function loadReviewQueueState(params: {
  listQueue: typeof listShadeReviewQueue;
  request: { state: ShadeReviewQueueState; page: number; q: string };
  isMounted: () => boolean;
  setIsLoading: (loading: boolean) => void;
  setLoadError: (message: string | null) => void;
  setResponse: (response: ShadeReviewListResponse) => void;
}): Promise<void> {
  const { listQueue, request, isMounted, setIsLoading, setLoadError, setResponse } = params;
  try {
    if (isMounted()) {
      setIsLoading(true);
      setLoadError(null);
    }
    const response = await listQueue({ ...request, pageSize: PAGE_SIZE });
    if (isMounted()) setResponse(response);
  } catch (error) {
    if (isMounted()) setLoadError(error instanceof Error ? error.message : "Failed to load the review queue");
  } finally {
    if (isMounted()) setIsLoading(false);
  }
}

/**
 * Run one review action: optional confirmation gate, pending/error state, then refresh.
 * Returns true when the action ran and succeeded.
 */
export async function runReviewAction(params: {
  confirm?: () => boolean;
  action: () => Promise<{ message: string }>;
  setPending: (pending: boolean) => void;
  setError: (message: string | null) => void;
  setNotice: (message: string | null) => void;
  refresh: () => Promise<void>;
}): Promise<boolean> {
  if (params.confirm && !params.confirm()) return false;
  try {
    params.setPending(true);
    params.setError(null);
    params.setNotice(null);
    const result = await params.action();
    params.setNotice(result.message);
    await params.refresh();
    return true;
  } catch (error) {
    params.setError(error instanceof Error ? error.message : "Review action failed");
    return false;
  } finally {
    params.setPending(false);
  }
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

function Swatch({ hex, size = "md", className }: { hex: string | null; size?: "sm" | "md" | "lg"; className?: string }) {
  const sizes = { sm: "h-6 w-6", md: "h-10 w-10", lg: "h-20 w-20" };
  return (
    <span
      className={cn(
        "inline-block shrink-0 rounded-md border",
        hex ? "border-border" : "border-dashed border-muted-foreground/50 bg-muted",
        sizes[size],
        className
      )}
      style={hex ? { backgroundColor: hex } : undefined}
      title={hex ?? "No hex"}
      aria-label={hex ? `Color ${hex}` : "No color"}
      role="img"
    />
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}

/**
 * Admin "Review queue" tab: user-submitted shades awaiting review, compared side by side with
 * fuzzy-matched catalog shades, with approve / edit & approve / merge / reject actions.
 */
export function ReviewQueueTab() {
  const mountedRef = useRef(true);
  const { finishTypes } = useReferenceData();
  const finishOptions = useMemo(() => buildFinishOptions(finishTypes), [finishTypes]);

  const [queueState, setQueueState] = useState<ShadeReviewQueueState>("pending");
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [response, setResponse] = useState<ShadeReviewListResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [candidateOverride, setCandidateOverride] = useState<ShadeReviewMergeCandidate[] | null>(null);
  const [candidateQuery, setCandidateQuery] = useState("");
  const [candidateLoading, setCandidateLoading] = useState(false);
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);

  const [editForm, setEditForm] = useState<ApproveFormState | null>(null);
  const [rejectNote, setRejectNote] = useState("");
  const [actionPending, setActionPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadQueue = useCallback(async () => {
    await loadReviewQueueState({
      listQueue: listShadeReviewQueue,
      request: { state: queueState, page, q: search },
      isMounted: () => mountedRef.current,
      setIsLoading,
      setLoadError,
      setResponse,
    });
  }, [queueState, page, search]);

  useEffect(() => {
    mountedRef.current = true;
    void loadQueue();
    return () => {
      mountedRef.current = false;
    };
  }, [loadQueue]);

  const items = useMemo(() => response?.items ?? [], [response]);
  const selected = useMemo(
    () => items.find((item) => item.shadeId === selectedId) ?? items[0] ?? null,
    [items, selectedId]
  );
  const candidates = candidateOverride ?? selected?.candidates ?? [];
  const selectedCandidate =
    candidates.find((candidate) => candidate.shadeId === selectedCandidateId) ?? candidates[0] ?? null;
  const comparison = selected ? buildComparisonRows(selected, selectedCandidate) : [];
  const totalPages = response ? Math.max(1, Math.ceil(response.total / response.pageSize)) : 1;

  function selectItem(item: ShadeReviewItem) {
    setSelectedId(item.shadeId);
    setCandidateOverride(null);
    setCandidateQuery("");
    setSelectedCandidateId(null);
    setEditForm(null);
    setRejectNote("");
    setActionError(null);
  }

  async function searchCandidates() {
    if (!selected) return;
    try {
      setCandidateLoading(true);
      setActionError(null);
      const result = await getShadeReviewCandidates(selected.shadeId, { q: candidateQuery });
      setCandidateOverride(result.candidates);
      setSelectedCandidateId(result.candidates[0]?.shadeId ?? null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Failed to search candidates");
    } finally {
      setCandidateLoading(false);
    }
  }

  const afterAction = useCallback(async () => {
    setSelectedId(null);
    setCandidateOverride(null);
    setSelectedCandidateId(null);
    setEditForm(null);
    setRejectNote("");
    await loadQueue();
  }, [loadQueue]);

  async function handleApprove(form: ApproveFormState | null) {
    if (!selected) return;
    if (form) {
      const validation = validateApproveForm(form);
      if (validation) {
        setActionError(validation);
        return;
      }
    }
    const payload = form ? buildApprovePayload(selected, form) : {};
    await runReviewAction({
      confirm: () =>
        window.confirm(`Approve "${form?.brand.trim() || selected.brand} — ${form?.name.trim() || selected.name}" into the shared catalog?`),
      action: () => approveShadeReview(selected.shadeId, payload),
      setPending: setActionPending,
      setError: setActionError,
      setNotice,
      refresh: afterAction,
    });
  }

  async function handleMerge() {
    if (!selected || !selectedCandidate) return;
    await runReviewAction({
      confirm: () => window.confirm(mergeConfirmationMessage(selected, selectedCandidate)),
      action: () => mergeShadeReview(selected.shadeId, { targetShadeId: selectedCandidate.shadeId }),
      setPending: setActionPending,
      setError: setActionError,
      setNotice,
      refresh: afterAction,
    });
  }

  async function handleReject() {
    if (!selected) return;
    await runReviewAction({
      confirm: () =>
        window.confirm(`Reject "${selected.brand} — ${selected.name}"? It stays private to its submitter; no data is deleted.`),
      action: () => rejectShadeReview(selected.shadeId, rejectNote.trim() ? { note: rejectNote.trim() } : {}),
      setPending: setActionPending,
      setError: setActionError,
      setNotice,
      refresh: afterAction,
    });
  }

  function changeQueueState(next: ShadeReviewQueueState) {
    setQueueState(next);
    setPage(1);
    setSelectedId(null);
    setCandidateOverride(null);
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Shades users added that are not in the catalog yet. They stay private to the people who own them until you
        approve them, merge them into an existing catalog shade (their inventory moves), or reject them (they stay
        private).
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <ToggleChip pressed={queueState === "pending"} onPressedChange={() => changeQueueState("pending")}>
          Pending
        </ToggleChip>
        <ToggleChip pressed={queueState === "rejected"} onPressedChange={() => changeQueueState("rejected")}>
          Rejected
        </ToggleChip>
        <form
          className="flex min-w-[220px] flex-1 items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setPage(1);
            setSearch(searchInput.trim());
          }}
        >
          <Input
            placeholder="Filter by brand or name"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
          />
          <Button type="submit" variant="outline" size="sm">
            Filter
          </Button>
        </form>
        <Badge variant="outline">{response?.total ?? 0} {queueState}</Badge>
        <Button variant="outline" size="sm" onClick={() => void loadQueue()} disabled={isLoading}>
          {isLoading ? "Refreshing…" : "Refresh"}
        </Button>
      </div>

      {loadError && <p className="text-sm text-destructive">{loadError}</p>}
      {notice && (
        <p className="rounded-md border bg-muted/30 p-2 text-sm" role="status">
          {notice}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        {/* Queue */}
        <div className="space-y-2">
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12" />
                  <TableHead>Submission</TableHead>
                  <TableHead className="text-right">Users</TableHead>
                  <TableHead>Added</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading && items.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-muted-foreground">
                      Loading review queue…
                    </TableCell>
                  </TableRow>
                )}
                {!isLoading && items.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-muted-foreground">
                      {queueState === "pending" ? "Nothing to review." : "No rejected submissions."}
                    </TableCell>
                  </TableRow>
                )}
                {items.map((item) => (
                  <TableRow
                    key={item.shadeId}
                    onClick={() => selectItem(item)}
                    data-state={selected?.shadeId === item.shadeId ? "selected" : undefined}
                    className="cursor-pointer"
                  >
                    <TableCell>
                      <Swatch hex={item.displayHex} size="sm" />
                    </TableCell>
                    <TableCell>
                      <div className="font-medium">{item.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {item.brand}
                        {item.candidates.length > 0 && (
                          <> · best match {formatSimilarity(item.candidates[0].similarity)}</>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">{item.submitterCount}</TableCell>
                    <TableCell className="text-xs">{formatDate(item.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {totalPages > 1 && (
            <div className="flex items-center justify-between text-sm">
              <Button variant="outline" size="sm" disabled={page <= 1 || isLoading} onClick={() => setPage(page - 1)}>
                Previous
              </Button>
              <span className="text-muted-foreground">
                Page {page} of {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages || isLoading}
                onClick={() => setPage(page + 1)}
              >
                Next
              </Button>
            </div>
          )}
        </div>

        {/* Detail */}
        {selected ? (
          <div className="space-y-4 rounded-md border p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h3 className="text-lg font-semibold">
                  {selected.brand} — {selected.name}
                </h3>
                <p className="text-xs text-muted-foreground">
                  #{selected.shadeId} · submitted {formatDate(selected.createdAt)}
                  {selected.createdByUserId !== null && <> by user #{selected.createdByUserId}</>} · held by{" "}
                  {selected.submitterCount} {selected.submitterCount === 1 ? "user" : "users"}
                </p>
                {selected.reviewStatus === "rejected" && (
                  <p className="text-xs text-muted-foreground">
                    Rejected {selected.reviewedAt ? formatDate(selected.reviewedAt) : ""}
                    {selected.reviewedByUserId !== null && <> by user #{selected.reviewedByUserId}</>}
                    {selected.reviewNote && <> — “{selected.reviewNote}”</>}
                  </p>
                )}
              </div>
            </div>

            {/* Side-by-side comparison */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2 rounded-md border bg-muted/20 p-3">
                <p className="text-xs font-semibold uppercase text-muted-foreground">Submission</p>
                <Swatch hex={selected.displayHex} size="lg" />
                <FinishBadges polish={selected} finishTypes={finishTypes} empty={<span className="text-xs text-muted-foreground">No finish</span>} />
              </div>
              <div className="space-y-2 rounded-md border bg-muted/20 p-3">
                <p className="text-xs font-semibold uppercase text-muted-foreground">
                  {selectedCandidate ? `Catalog #${selectedCandidate.shadeId}` : "No candidate selected"}
                </p>
                {selectedCandidate && (
                  <>
                    <div className="flex items-center gap-2">
                      <Swatch hex={selectedCandidate.displayHex} size="lg" />
                      {selectedCandidate.swatchImageUrl && (
                        // Public catalog swatch served through the signed image proxy.
                        <SwatchThumbnail
                          src={selectedCandidate.swatchImageUrl}
                          displaySize={80}
                          alt={`${selectedCandidate.brand} ${selectedCandidate.name}`}
                          className="h-20 w-20 rounded-md border object-cover"
                        />
                      )}
                    </div>
                    <FinishBadges polish={selectedCandidate} finishTypes={finishTypes} empty={<span className="text-xs text-muted-foreground">No finish</span>} />
                    <p className="text-xs text-muted-foreground">
                      {describeColorDistance(selectedCandidate.colorDistance)} · {selectedCandidate.inventoryCount} inventory rows
                    </p>
                  </>
                )}
              </div>
            </div>

            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Field</TableHead>
                    <TableHead>Submission</TableHead>
                    <TableHead>Candidate</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {comparison.map((row) => (
                    <TableRow key={row.field} className={cn(row.differs && "bg-amber-500/10")}>
                      <TableCell className="text-xs font-medium">{row.label}</TableCell>
                      <TableCell className="text-xs">{row.submission || "—"}</TableCell>
                      <TableCell className="text-xs">{selectedCandidate ? row.candidate || "—" : ""}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {/* Candidates */}
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium">Merge candidates</p>
                <form
                  className="flex items-center gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void searchCandidates();
                  }}
                >
                  <Input
                    className="h-8 w-48"
                    placeholder="Search catalog by name"
                    value={candidateQuery}
                    onChange={(event) => setCandidateQuery(event.target.value)}
                  />
                  <Button type="submit" size="sm" variant="outline" disabled={candidateLoading}>
                    {candidateLoading ? "Searching…" : "Search"}
                  </Button>
                </form>
              </div>
              {candidates.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No similar catalog shades found. Search by name, or approve it as a new catalog shade.
                </p>
              ) : (
                <ul className="space-y-1" role="radiogroup" aria-label="Merge candidates">
                  {candidates.map((candidate) => {
                    const active = selectedCandidate?.shadeId === candidate.shadeId;
                    return (
                      <li key={candidate.shadeId}>
                        <button
                          type="button"
                          role="radio"
                          aria-checked={active}
                          onClick={() => setSelectedCandidateId(candidate.shadeId)}
                          className={cn(
                            "flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left text-sm transition-colors",
                            active ? "border-primary bg-primary/5" : "hover:bg-muted/40"
                          )}
                        >
                          <Swatch hex={candidate.displayHex} size="sm" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium">
                              {candidate.brand} — {candidate.name}
                            </span>
                            <span className="block text-xs text-muted-foreground">
                              #{candidate.shadeId} · {describeColorDistance(candidate.colorDistance)}
                              {candidate.sameBrand ? " · same brand" : ""}
                            </span>
                          </span>
                          <Badge variant="outline">{formatSimilarity(candidate.similarity)}</Badge>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {/* Edit & approve */}
            {editForm && (
              <div className="space-y-3 rounded-md border p-3">
                <p className="text-sm font-medium">Edit before approving</p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {(
                    [
                      ["brand", "Brand"],
                      ["name", "Name"],
                      ["collection", "Collection"],
                      ["colorName", "Color name"],
                      ["vendorHex", "Vendor hex"],
                      ["nameHex", "Name hex"],
                    ] as const
                  ).map(([field, label]) => (
                    <label key={field} className="space-y-1 text-xs font-medium">
                      {label}
                      <Input
                        value={editForm[field]}
                        onChange={(event) => setEditForm({ ...editForm, [field]: event.target.value })}
                      />
                    </label>
                  ))}
                </div>
                <div className="space-y-1">
                  <p className="text-xs font-medium">Finishes (first selected is primary)</p>
                  <div className="flex flex-wrap gap-1">
                    {finishOptions.map((option) => {
                      const pressed = editForm.finishes.includes(option.value);
                      return (
                        <ToggleChip
                          key={option.value}
                          pressed={pressed}
                          onPressedChange={(next) =>
                            setEditForm({
                              ...editForm,
                              finishes: next
                                ? [...editForm.finishes, option.value]
                                : editForm.finishes.filter((finish) => finish !== option.value),
                            })
                          }
                        >
                          {option.label}
                        </ToggleChip>
                      );
                    })}
                  </div>
                </div>
                <label className="block space-y-1 text-xs font-medium">
                  Note (optional, kept for the audit trail)
                  <Input value={editForm.note} onChange={(event) => setEditForm({ ...editForm, note: event.target.value })} />
                </label>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => void handleApprove(editForm)} disabled={actionPending}>
                    {actionPending ? "Saving…" : "Save & approve"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditForm(null)} disabled={actionPending}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}

            {actionError && <p className="text-sm text-destructive">{actionError}</p>}

            {/* Actions */}
            {!editForm && (
              <div className="space-y-2">
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => void handleApprove(null)} disabled={actionPending}>
                    Approve
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setEditForm(approveFormFromItem(selected))} disabled={actionPending}>
                    Edit &amp; approve
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void handleMerge()}
                    disabled={actionPending || !selectedCandidate}
                    title={selectedCandidate ? undefined : "Select a merge candidate first"}
                  >
                    {selectedCandidate ? `Merge into #${selectedCandidate.shadeId}` : "Merge"}
                  </Button>
                  {selected.reviewStatus !== "rejected" && (
                    <Button size="sm" variant="destructive" onClick={() => void handleReject()} disabled={actionPending}>
                      Reject
                    </Button>
                  )}
                </div>
                {selected.reviewStatus !== "rejected" && (
                  <Input
                    className="h-8"
                    placeholder="Rejection note (optional)"
                    value={rejectNote}
                    onChange={(event) => setRejectNote(event.target.value)}
                  />
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="flex min-h-[200px] items-center justify-center rounded-md border text-sm text-muted-foreground">
            {isLoading ? "Loading…" : "Select a submission to review."}
          </div>
        )}
      </div>
    </div>
  );
}
