"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { toast } from "sonner";
import { Camera, Check, ImageOff, Loader2, Search, Trash2 } from "lucide-react";
import {
  BOTTLE_EVAL_MAX_FRAMES,
  BOTTLE_EVAL_MAX_NOTES_LENGTH,
  BOTTLE_EVAL_MAX_TEXT_LENGTH,
  BOTTLE_SURFACES,
  type BottleEvalSample,
  type BottleEvalSampleRequest,
  type BottleSurface,
  type CatalogSearchResult,
} from "swatchwatch-shared";
import {
  addBottleEvalFrame,
  createBottleEvalSample,
  deleteBottleEvalFrame,
  deleteBottleEvalSample,
  listBottleEvalSamples,
  searchCatalog,
} from "@/lib/api";
import {
  bottleEvalReducer,
  canFinish,
  frameTypeForSurface,
  INITIAL_BOTTLE_EVAL_STATE,
  nextShot,
  type BottleEvalLabel,
  type ShotEntry,
} from "@/lib/bottle-eval";
import type { CaptureFrameEntry } from "@/lib/rapid-add-flow";
import { trackEvent } from "@/lib/telemetry";
import { cn } from "@/lib/utils";
import { CameraCapture, type CameraCaptureEvent } from "@/components/rapid-add/camera-capture";
import { FrameStrip } from "@/components/rapid-add/frame-strip";
import { PrivateImage } from "@/components/private-image";
import { ToggleChip } from "@/components/toggle-chip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

const SEARCH_DEBOUNCE_MS = 300;
const SEARCH_LIMIT = 8;
const LIST_PAGE_SIZE = 25;

const SURFACE_LABEL: Record<BottleSurface, string> = {
  front: "Front",
  bottom: "Bottom",
  glass: "Glass",
  box: "Box",
};

/** Overlay letter on saved-sample thumbnails (box gets "X" so it never collides with bottom). */
const SURFACE_LETTER: Record<BottleSurface, string> = {
  front: "F",
  bottom: "B",
  glass: "G",
  box: "X",
};

const TEXTAREA_CLASS =
  "w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function newLocalId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function labelText(label: BottleEvalLabel): { brand: string; shade: string } {
  return label.kind === "catalog"
    ? { brand: label.brand, shade: label.shadeName }
    : { brand: label.brandText, shade: label.shadeText };
}

function sampleRequest(label: BottleEvalLabel, notes: string): BottleEvalSampleRequest {
  const trimmedNotes = notes.trim();
  const base: BottleEvalSampleRequest =
    label.kind === "catalog"
      ? { shadeId: label.shadeId }
      : { brandText: label.brandText, shadeText: label.shadeText };
  return trimmedNotes ? { ...base, notes: trimmedNotes } : base;
}

function toFrameEntry(shot: ShotEntry): CaptureFrameEntry {
  return {
    localId: shot.localId,
    frameType: frameTypeForSurface(shot.surface),
    dataUrl: shot.dataUrl,
    quality: {},
    status: shot.status,
    attempts: 1,
    frameId: shot.frameId,
    error: shot.error,
  };
}

/**
 * Admin "Bottle Eval" tab: label a bottle (catalog shade, or brand + shade text), photograph its
 * front, bottom, glass and (optional) box with the Rapid Add camera, and save the photos as a
 * private eval sample for bottle recognition (`/api/bottle-eval-admin/*`).
 */
export function BottleEvalTab() {
  const [state, dispatch] = useReducer(bottleEvalReducer, INITIAL_BOTTLE_EVAL_STATE);
  const [skipped, setSkipped] = useState<ReadonlySet<BottleSurface>>(() => new Set());
  const [manualSurface, setManualSurface] = useState<BottleSurface | null>(null);
  const [creating, setCreating] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [listReloadToken, setListReloadToken] = useState(0);
  // Uploaded shots whose server frame is being deleted (state for the UI, ref against double submits).
  const [removingLocalIds, setRemovingLocalIds] = useState<ReadonlySet<string>>(() => new Set());
  const removingRef = useRef<Set<string>>(new Set());

  const guided = nextShot(state, skipped);
  const currentSurface: BottleSurface | null = manualSurface ?? guided?.surface ?? null;
  const uploadedCount = state.shots.filter((shot) => shot.status === "uploaded").length;
  const frameLimitReached = state.shots.length >= BOTTLE_EVAL_MAX_FRAMES;
  const finishEnabled = canFinish(state);

  const resetSession = useCallback(() => {
    dispatch({ type: "reset" });
    setSkipped(new Set());
    setManualSurface(null);
    removingRef.current = new Set();
    setRemovingLocalIds(new Set());
  }, []);

  const refreshList = useCallback(() => setListReloadToken((token) => token + 1), []);

  async function chooseLabel(label: BottleEvalLabel) {
    if (creating) return;
    dispatch({ type: "label_chosen", label });
    setCreating(true);
    try {
      const response = await createBottleEvalSample(sampleRequest(label, state.notes));
      dispatch({ type: "sample_created", sampleId: response.sample.sampleId });
      trackEvent("bottle_eval_ui.sample_created", { inCatalog: label.kind === "catalog" });
    } catch (error) {
      toast.error(errorMessage(error, "Couldn't create the sample"));
    } finally {
      setCreating(false);
    }
  }

  const uploadShot = useCallback(async (sampleId: string, localId: string, surface: BottleSurface, dataUrl: string) => {
    try {
      const { frameId } = await addBottleEvalFrame(sampleId, { surface, image: dataUrl });
      dispatch({ type: "shot_uploaded", localId, frameId });
      trackEvent("bottle_eval_ui.frame_added", { surface });
    } catch (error) {
      dispatch({ type: "shot_failed", localId, error: errorMessage(error, "Upload failed") });
    }
  }, []);

  function handleCapture(event: CameraCaptureEvent) {
    if (!event.frame || !state.sampleId || !currentSurface || frameLimitReached) return;
    const localId = newLocalId();
    const dataUrl = event.frame.dataUrl;
    dispatch({ type: "shot_added", shot: { localId, surface: currentSurface, dataUrl } });
    // A hand-picked surface is a one-off extra shot; the guided order resumes after it.
    setManualSurface(null);
    void uploadShot(state.sampleId, localId, currentSurface, dataUrl);
  }

  // The reducer has no failed → uploading transition, so a retry replaces the failed shot with a
  // new "uploading" one (same surface and photo); canFinish then waits for it.
  function handleRetry(localId: string) {
    const shot = state.shots.find((entry) => entry.localId === localId);
    if (!shot || shot.status !== "failed" || !state.sampleId) return;
    const retryId = newLocalId();
    dispatch({ type: "shot_removed", localId });
    dispatch({ type: "shot_added", shot: { localId: retryId, surface: shot.surface, dataUrl: shot.dataUrl } });
    void uploadShot(state.sampleId, retryId, shot.surface, shot.dataUrl);
  }

  function setRemoving(localId: string, removing: boolean) {
    if (removing) removingRef.current.add(localId);
    else removingRef.current.delete(localId);
    setRemovingLocalIds(new Set(removingRef.current));
  }

  // A failed shot is local only; an uploaded one deletes its server frame first and stays on failure.
  async function handleRemove(localId: string) {
    const shot = state.shots.find((entry) => entry.localId === localId);
    if (!shot) return;
    if (shot.status === "failed") {
      dispatch({ type: "shot_removed", localId });
      return;
    }
    if (shot.status !== "uploaded" || !state.sampleId || removingRef.current.has(localId)) return;
    if (!shot.frameId) {
      toast.error("Couldn't remove the photo");
      return;
    }
    setRemoving(localId, true);
    try {
      await deleteBottleEvalFrame(state.sampleId, shot.frameId);
      dispatch({ type: "frame_deleted", localId });
      trackEvent("bottle_eval_ui.frame_deleted", { surface: shot.surface });
    } catch (error) {
      toast.error(errorMessage(error, "Couldn't remove the photo"));
    } finally {
      setRemoving(localId, false);
    }
  }

  function handleSkip() {
    if (!guided) return;
    setSkipped((prev) => new Set(prev).add(guided.surface));
  }

  function handleFinish() {
    if (!finishEnabled) return;
    dispatch({ type: "finished" });
    refreshList();
  }

  async function handleDiscard() {
    if (!state.sampleId || discarding) return;
    if (uploadedCount > 0 && !window.confirm(`Discard this sample and its ${uploadedCount} uploaded photo(s)?`)) {
      return;
    }
    setDiscarding(true);
    try {
      await deleteBottleEvalSample(state.sampleId);
      trackEvent("bottle_eval_ui.sample_deleted");
      resetSession();
    } catch (error) {
      toast.error(errorMessage(error, "Couldn't discard the sample"));
    } finally {
      setDiscarding(false);
    }
  }

  const frameEntries = useMemo(() => state.shots.map(toFrameEntry), [state.shots]);

  const label = state.label ? labelText(state.label) : null;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Bottle Eval</h2>
        <p className="text-sm text-muted-foreground">
          Label a bottle, then photograph its front, bottom, glass and box. Photos are private eval samples for
          bottle recognition and never touch the catalog.
        </p>
      </div>

      <Card>
        <CardContent className="space-y-4">
          {state.phase === "label" && (
            <LabelStep
              notes={state.notes}
              onNotesChange={(notes) => dispatch({ type: "notes_changed", notes })}
              creating={creating}
              onChoose={(chosen) => void chooseLabel(chosen)}
            />
          )}

          {state.phase === "shooting" && label && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Shooting</p>
                  <p className="truncate font-semibold">
                    {label.brand} · {label.shade}
                    {state.label?.kind === "external" && (
                      <Badge variant="outline" className="ml-2 align-middle">
                        not in catalog
                      </Badge>
                    )}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => void handleDiscard()}
                    disabled={discarding}
                  >
                    {discarding ? "Discarding…" : "Discard"}
                  </Button>
                  <Button type="button" size="sm" onClick={handleFinish} disabled={!finishEnabled}>
                    <Check aria-hidden /> Finish
                  </Button>
                </div>
              </div>

              <div className="rounded-lg border border-border/60 bg-muted/40 p-3" aria-live="polite">
                {manualSurface ? (
                  <p className="font-medium">Extra shot: {SURFACE_LABEL[manualSurface]}</p>
                ) : guided ? (
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-medium">
                      {guided.prompt}
                      {guided.optional && <span className="ml-1 text-sm text-muted-foreground">(optional)</span>}
                    </p>
                    <Button type="button" variant="outline" size="sm" onClick={handleSkip}>
                      Can&apos;t see it
                    </Button>
                  </div>
                ) : (
                  <p className="font-medium">
                    All surfaces done. Pick a surface below for an extra shot, or Finish.
                  </p>
                )}
                <div className="mt-3 flex flex-wrap items-center gap-1.5" role="group" aria-label="Shoot a surface">
                  {BOTTLE_SURFACES.map((surface) => {
                    const count = state.shots.filter(
                      (shot) => shot.surface === surface && shot.status !== "failed",
                    ).length;
                    return (
                      <ToggleChip
                        key={surface}
                        pressed={currentSurface === surface}
                        onPressedChange={(pressed) => setManualSurface(pressed ? surface : null)}
                        className="h-7 px-2.5 py-1 text-xs"
                      >
                        {SURFACE_LABEL[surface]}
                        {count > 0 && <span className="tabular-nums opacity-80">×{count}</span>}
                        {skipped.has(surface) && count === 0 && <span className="opacity-70">skipped</span>}
                      </ToggleChip>
                    );
                  })}
                </div>
              </div>

              <CameraCapture
                scanBarcodes={false}
                captureDisabled={!currentSurface || frameLimitReached}
                frameType={frameTypeForSurface(currentSurface ?? "front")}
                onFrameTypeChange={() => {}}
                hideFrameTypeOptions
                onCapture={handleCapture}
              />

              {frameLimitReached && (
                <p className="text-xs text-muted-foreground">
                  A sample holds at most {BOTTLE_EVAL_MAX_FRAMES} photos.
                </p>
              )}

              <FrameStrip
                frames={frameEntries}
                onRetry={handleRetry}
                onRemove={(localId) => void handleRemove(localId)}
                allowRemoveUploaded
                removingLocalIds={removingLocalIds}
              />
            </div>
          )}

          {state.phase === "saved" && label && (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="font-medium">
                Saved {uploadedCount} {uploadedCount === 1 ? "frame" : "frames"} for {label.brand} {label.shade}
              </p>
              <Button type="button" onClick={resetSession}>
                <Camera aria-hidden /> Shoot another
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <RecentSamples
        reloadToken={listReloadToken}
        activeSampleId={state.phase === "shooting" ? state.sampleId : null}
        onDeleted={refreshList}
      />
    </div>
  );
}

// ── Label step ──────────────────────────────────────────────────────────────

function LabelStep({
  notes,
  onNotesChange,
  creating,
  onChoose,
}: {
  notes: string;
  onNotesChange: (notes: string) => void;
  creating: boolean;
  onChoose: (label: BottleEvalLabel) => void;
}) {
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<{ query: string; results: CatalogSearchResult[]; error: string | null } | null>(
    null,
  );
  const [external, setExternal] = useState(false);
  const [brandText, setBrandText] = useState("");
  const [shadeText, setShadeText] = useState("");

  const trimmedQuery = query.trim();

  useEffect(() => {
    if (external || trimmedQuery.length < 2) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const response = await searchCatalog(trimmedQuery, SEARCH_LIMIT);
          if (!cancelled) setSearch({ query: trimmedQuery, results: response.results, error: null });
        } catch (error) {
          if (!cancelled) {
            setSearch({ query: trimmedQuery, results: [], error: errorMessage(error, "Catalog search failed") });
          }
        }
      })();
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [external, trimmedQuery]);

  const current = search && search.query === trimmedQuery ? search : null;
  const searching = trimmedQuery.length >= 2 && !current;
  const canContinue = brandText.trim().length > 0 && shadeText.trim().length > 0 && !creating;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium">Which bottle is this?</p>
        <ToggleChip pressed={external} onPressedChange={setExternal} className="h-7 px-2.5 py-1 text-xs">
          Not in catalog
        </ToggleChip>
      </div>

      {external ? (
        <form
          className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canContinue) return;
            onChoose({ kind: "external", brandText: brandText.trim(), shadeText: shadeText.trim() });
          }}
        >
          <label className="space-y-1 text-sm">
            <span className="text-xs font-medium text-muted-foreground">Brand</span>
            <Input
              value={brandText}
              maxLength={BOTTLE_EVAL_MAX_TEXT_LENGTH}
              onChange={(event) => setBrandText(event.target.value)}
              placeholder="e.g. Holo Taco"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-xs font-medium text-muted-foreground">Shade</span>
            <Input
              value={shadeText}
              maxLength={BOTTLE_EVAL_MAX_TEXT_LENGTH}
              onChange={(event) => setShadeText(event.target.value)}
              placeholder="e.g. One Coat Black"
            />
          </label>
          <Button type="submit" disabled={!canContinue}>
            {creating ? "Creating…" : "Continue"}
          </Button>
        </form>
      ) : (
        <div className="space-y-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search the catalog by brand or shade"
              aria-label="Search the catalog"
              className="pl-8"
            />
          </div>
          {searching && (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" aria-hidden /> Searching…
            </p>
          )}
          {current?.error && <p className="text-xs text-destructive">{current.error}</p>}
          {current && !current.error && current.results.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No catalog matches. Use &ldquo;Not in catalog&rdquo; to type the brand and shade.
            </p>
          )}
          {current && current.results.length > 0 && (
            <ul className="divide-y rounded-lg border border-border/60" aria-label="Catalog matches">
              {current.results.map((result) => {
                const finishes = result.finishes?.length ? result.finishes : result.finish ? [result.finish] : [];
                return (
                  <li key={result.shadeId}>
                    <button
                      type="button"
                      disabled={creating}
                      onClick={() =>
                        onChoose({
                          kind: "catalog",
                          shadeId: result.shadeId,
                          brand: result.brand,
                          shadeName: result.name,
                        })
                      }
                      className="flex w-full flex-wrap items-baseline gap-x-2 px-3 py-2 text-left text-sm hover:bg-muted disabled:opacity-50"
                    >
                      <span className="text-muted-foreground">{result.brand}</span>
                      <span className="font-medium">{result.name}</span>
                      {finishes.length > 0 && (
                        <span className="text-xs text-muted-foreground">{finishes.join(", ")}</span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {creating && <p className="text-xs text-muted-foreground">Creating sample…</p>}
        </div>
      )}

      <label className="block space-y-1 text-sm">
        <span className="text-xs font-medium text-muted-foreground">Notes (optional, saved with the sample)</span>
        <textarea
          value={notes}
          maxLength={BOTTLE_EVAL_MAX_NOTES_LENGTH}
          rows={2}
          onChange={(event) => onNotesChange(event.target.value)}
          className={TEXTAREA_CLASS}
          placeholder="e.g. worn label, mini bottle, shot under warm light"
        />
      </label>
    </div>
  );
}

// ── Recent samples ──────────────────────────────────────────────────────────

interface SampleListState {
  key: number;
  samples: BottleEvalSample[];
  total: number;
  nextCursor: string | null;
}

function RecentSamples({
  reloadToken,
  activeSampleId,
  onDeleted,
}: {
  reloadToken: number;
  activeSampleId: string | null;
  onDeleted: () => void;
}) {
  const [list, setList] = useState<SampleListState | null>(null);
  const [loadError, setLoadError] = useState<{ key: number; message: string } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await listBottleEvalSamples({ limit: LIST_PAGE_SIZE });
        if (cancelled) return;
        setList({ key: reloadToken, samples: response.samples, total: response.total, nextCursor: response.nextCursor });
        setLoadError(null);
      } catch (error) {
        if (!cancelled) setLoadError({ key: reloadToken, message: errorMessage(error, "Failed to load samples") });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  async function loadMore() {
    if (!list?.nextCursor || loadingMore) return;
    setLoadingMore(true);
    const key = list.key;
    try {
      const response = await listBottleEvalSamples({ after: list.nextCursor, limit: LIST_PAGE_SIZE });
      setList((prev) =>
        prev && prev.key === key
          ? {
              ...prev,
              samples: [...prev.samples, ...response.samples],
              total: response.total,
              nextCursor: response.nextCursor,
            }
          : prev,
      );
    } catch (error) {
      toast.error(errorMessage(error, "Failed to load more samples"));
    } finally {
      setLoadingMore(false);
    }
  }

  async function handleDelete(sample: BottleEvalSample) {
    if (deletingId) return;
    const name = `${sample.brand} ${sample.shadeName}`;
    if (!window.confirm(`Delete the sample for ${name} and its ${sample.frames.length} photo(s)?`)) return;
    setDeletingId(sample.sampleId);
    try {
      await deleteBottleEvalSample(sample.sampleId);
      trackEvent("bottle_eval_ui.sample_deleted");
      toast.success(`Deleted ${name}`);
      onDeleted();
    } catch (error) {
      toast.error(errorMessage(error, "Couldn't delete the sample"));
    } finally {
      setDeletingId(null);
    }
  }

  const isLoading = list?.key !== reloadToken && loadError?.key !== reloadToken;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Recent samples</CardTitle>
        <CardDescription>
          {list ? `${list.total} ${list.total === 1 ? "sample" : "samples"}, newest first.` : "Newest first."} Photos
          another admin took show as placeholders.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loadError?.key === reloadToken && <p className="text-sm text-destructive">{loadError.message}</p>}
        {isLoading && !list && (
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden /> Loading samples…
          </p>
        )}
        {list && list.samples.length === 0 && (
          <p className="text-sm text-muted-foreground">No samples yet. Label a bottle above to start.</p>
        )}
        {list && list.samples.length > 0 && (
          <ul className={cn("divide-y", isLoading && "opacity-60")} aria-label="Recent bottle eval samples">
            {list.samples.map((sample) => (
              <li key={sample.sampleId} className="flex flex-wrap items-start gap-3 py-3">
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm text-muted-foreground">{sample.brand}</span>
                    <span className="font-medium">{sample.shadeName}</span>
                    {!sample.inCatalog && <Badge variant="outline">not in catalog</Badge>}
                    <span className="text-xs text-muted-foreground">
                      {new Date(sample.createdAt).toLocaleString()}
                    </span>
                  </div>
                  {sample.notes && <p className="text-xs text-muted-foreground">{sample.notes}</p>}
                  {sample.frames.length > 0 ? (
                    <ul className="flex flex-wrap gap-1.5" aria-label="Photos">
                      {sample.frames.map((frame) => (
                        <li key={frame.frameId} className="relative size-16 overflow-hidden rounded-md border">
                          {frame.imageUrl ? (
                            <PrivateImage
                              admin
                              src={frame.imageUrl}
                              alt={`${SURFACE_LABEL[frame.surface]} photo`}
                              className="size-full object-cover"
                              fallback={<ThumbnailPlaceholder text="Couldn't load" />}
                            />
                          ) : (
                            <ThumbnailPlaceholder text="Another admin's photo" />
                          )}
                          <span
                            className="absolute left-0.5 top-0.5 rounded bg-black/60 px-1 text-[10px] font-semibold text-white"
                            title={SURFACE_LABEL[frame.surface]}
                          >
                            {SURFACE_LETTER[frame.surface]}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-xs text-muted-foreground">No photos.</p>
                  )}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void handleDelete(sample)}
                  disabled={deletingId !== null || sample.sampleId === activeSampleId}
                  title={sample.sampleId === activeSampleId ? "Finish or discard this sample above" : undefined}
                >
                  <Trash2 aria-hidden /> {deletingId === sample.sampleId ? "Deleting…" : "Delete"}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {list?.nextCursor && (
          <Button type="button" variant="outline" size="sm" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? "Loading…" : "Load more"}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function ThumbnailPlaceholder({ text }: { text: string }) {
  return (
    <div
      role="img"
      aria-label={text}
      title={text}
      className="flex size-full flex-col items-center justify-center gap-0.5 bg-muted p-1 text-center text-[9px] leading-tight text-muted-foreground"
    >
      <ImageOff className="size-3.5" aria-hidden />
      {text}
    </div>
  );
}
