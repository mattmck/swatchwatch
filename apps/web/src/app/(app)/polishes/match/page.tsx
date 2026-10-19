"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type {
  ColorMatchGroup,
  MatchScope,
  Polish,
  PolishImageMatchResponse,
  PolishMatch,
} from "swatchwatch-shared";
import { ImageUp, X } from "lucide-react";
import { toast } from "sonner";
import { deletePolish, getPolishDupes, matchPolishesToImage, updatePolish } from "@/lib/api";
import { downscaleImageFile, type DownscaledImage } from "@/lib/image-downscale";
import { cropDownscaledImage } from "@/lib/image-crop";
import type { ImageRegion } from "@/lib/image-region";
import {
  activeColorGroups,
  activePaletteColors,
  confidenceCounts,
  DEFAULT_PALETTE_SELECTION,
  findPolishInResponse,
  hiddenByDefaultCount,
  MATCH_SCOPE_OPTIONS,
  matchEmptyReason,
  rankFlatMatches,
  replacePolishInResponse,
  shareResponsePolishes,
  togglePaletteColor,
  type PaletteSelection,
} from "@/lib/photo-match";
import {
  buildPhotoMatchQueryString,
  hasMatchFilters,
  matchRequestKey,
  parsePhotoMatchState,
  toMatchRequestOptions,
  type MatchView,
  type PhotoMatchUrlState,
} from "@/lib/photo-match-url";
import {
  clearPhotoMatchSession,
  forgetOtherPhotoMatchResponses,
  getPhotoMatchSession,
  rememberPhotoMatchResponse,
  startPhotoMatchSession,
} from "@/lib/photo-match-session";
import {
  applyInventoryPatch,
  collectionActionRequest,
  optimisticPolish,
  statusChangeEvent,
  type CollectionAction,
} from "@/lib/collection-actions";
import { isArchivingChange, isOwnedPolish, quantityChangeUpdate } from "@/lib/inventory-status";
import { shadeGuardKey, type AddGuardIntent } from "@/lib/add-guard";
import { buildFinishOptions } from "@/lib/finish-options";
import {
  trackMatchImageProcessed,
  trackMatchResultAction,
  type MatchImageTrigger,
  type MatchResultAction,
} from "@/lib/metrics-events";
import { trackEvent } from "@/lib/telemetry";
import { trackOnboardingStepClicked } from "@/lib/metrics-events";
import { useAddGuard } from "@/hooks/use-add-guard";
import { useReferenceData } from "@/hooks/use-reference-data";
import { AddGuardDialog } from "@/components/add-guard-dialog";
import { showArchivedToast } from "@/components/archived-toast";
import { BrandSpinner } from "@/components/brand-spinner";
import { ColorDot } from "@/components/color-dot";
import { ColorFamilyChips } from "@/components/color-family-chips";
import { CollectionQuickActions, type QuickActionSource } from "@/components/collection-quick-actions";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { useOwnedCount } from "@/hooks/use-owned-count";
import { CATALOG_SEARCH_HREF } from "@/lib/onboarding";
import { ToggleChip } from "@/components/toggle-chip";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  ConfidenceLegend,
  ExtractedPalette,
  ImageDropZone,
  MatchEmptyState,
  MatchResultsList,
  RegionControls,
  RegionPreview,
  type ImageSource,
} from "./match-components";
import { formatFraction } from "./match-utils";

type Status = "idle" | "processing" | "done" | "error";

/** Palette and result sizes asked of the API: 8 colors so hiding background/skin still leaves enough. */
const MATCH_REQUEST = { maxColors: 8, perColorLimit: 8, limit: 20 } as const;
/** Rows in the flat "All matches" view. */
const FLAT_LIMIT = 20;
/** Rows shown per color before "Show more". */
const GROUP_PREVIEW = 3;

const SCOPE_TITLES: Record<MatchScope, string> = {
  owned: "Matches in your collection",
  wishlist: "Matches on your wishlist",
  catalog: "Matches in the catalog",
};

/** The PUT response carries no `buyUrl` and may omit the swatch; keep what the row had. */
function keepRowExtras(updated: Polish, previous: Polish): Polish {
  return {
    ...updated,
    swatchImageUrl: updated.swatchImageUrl ?? previous.swatchImageUrl,
    buyUrl: updated.buyUrl ?? previous.buyUrl,
  };
}

function resultActionFor(action: CollectionAction): MatchResultAction {
  if (action.kind === "remove-from-wishlist") return "remove_wishlist";
  if (action.kind === "set-tried") return "tried";
  if (action.status === "wishlist") return "wishlist";
  if (action.status === "owned") return "own";
  return "status";
}

/**
 * Photo → polish matching (#105). The user picks, drops, or shoots a photo (optionally focusing
 * on one area); it is downscaled in the browser and sent to `POST /api/polishes/match-image`.
 * The page shows the extracted palette (background and skin colors hidden by default, every chip
 * tappable), the top matches per color or as one ranked list, and lets the user wishlist or own a
 * match on the spot. Scope, finish and color family filters run on the server; palette and view
 * choices are client-side. Everything but the photo lives in the URL (`lib/photo-match-url.ts`),
 * and the photo stays in memory (`lib/photo-match-session.ts`) so Back restores the page.
 */
export default function PolishImageMatchPage() {
  return (
    <Suspense fallback={<BrandSpinner label="Loading…" />}>
      <PolishImageMatchContent />
    </Suspense>
  );
}

function PolishImageMatchContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const searchParamsString = searchParams.toString();

  // ── URL state ──────────────────────────────────────────────────────────────
  const [urlState, setUrlState] = useState<PhotoMatchUrlState>(() => parsePhotoMatchState(searchParams));
  const urlQuery = buildPhotoMatchQueryString(urlState);
  // Latest state for callbacks and effects (synced first, before the effects below read it).
  const urlQueryRef = useRef(urlQuery);
  const urlStateRef = useRef(urlState);
  useEffect(() => {
    urlQueryRef.current = urlQuery;
    urlStateRef.current = urlState;
  }, [urlQuery, urlState]);

  useEffect(() => {
    const current = buildPhotoMatchQueryString(parsePhotoMatchState(new URLSearchParams(window.location.search)));
    if (current === urlQuery) return;
    router.replace(urlQuery ? `${pathname}?${urlQuery}` : pathname, { scroll: false });
  }, [urlQuery, pathname, router]);

  // Back/forward within the page (or a link to it with other params): adopt the URL.
  useEffect(() => {
    const parsed = parsePhotoMatchState(new URLSearchParams(searchParamsString));
    if (buildPhotoMatchQueryString(parsed) !== urlQueryRef.current) setUrlState(parsed);
  }, [searchParamsString]);

  const setScope = (scope: MatchScope) => setUrlState((prev) => ({ ...prev, scope }));
  const setFinish = (finish: string) => setUrlState((prev) => ({ ...prev, finish }));
  const setFamilies = (families: PhotoMatchUrlState["families"]) => setUrlState((prev) => ({ ...prev, families }));
  const setView = (view: MatchView) => setUrlState((prev) => ({ ...prev, view }));
  const setPalette = useCallback(
    (update: (prev: PaletteSelection) => PaletteSelection) =>
      setUrlState((prev) => ({ ...prev, palette: update(prev.palette) })),
    []
  );

  // ── Photo + results (restored from the in-memory session on Back) ──────────
  const requestKey = matchRequestKey(urlState);
  const [restored] = useState(() => getPhotoMatchSession());
  const [image, setImage] = useState<DownscaledImage | null>(restored?.image ?? null);
  const [fullImage, setFullImage] = useState<DownscaledImage | null>(restored?.fullImage ?? null);
  const [region, setRegion] = useState<ImageRegion | null>(null);
  const [result, setResult] = useState<{ key: string; response: PolishImageMatchResponse } | null>(() => {
    const cached = restored?.responses.get(requestKey);
    return cached ? { key: requestKey, response: cached } : null;
  });
  // A restored photo with a cached response for these filters is "done"; without one the match effect runs.
  const [status, setStatus] = useState<Status>(() =>
    !restored ? "idle" : restored.responses.has(requestKey) ? "done" : "processing"
  );
  const [error, setError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  // Matching only searches owned polishes: with none, say so before the user uploads a photo.
  const ownedCount = useOwnedCount();
  const requestIdRef = useRef(0);
  const triggerRef = useRef<MatchImageTrigger>("filters");

  const runMatch = useCallback(async (prepared: DownscaledImage, trigger: MatchImageTrigger) => {
    const state = urlStateRef.current;
    const key = matchRequestKey(state);
    const requestId = ++requestIdRef.current;

    const report = (response: PolishImageMatchResponse, cached: boolean, durationMs?: number) => {
      const active = activePaletteColors(response.extractedColors, state.palette);
      const flat = rankFlatMatches(response.colorMatches, active, FLAT_LIMIT);
      const counts = confidenceCounts(flat);
      trackMatchImageProcessed({
        trigger,
        scope: state.scope,
        finishFiltered: state.finish !== "all",
        familyFilterCount: state.families.length,
        extractedColorCount: response.extractedColors.length,
        hiddenColorCount: hiddenByDefaultCount(response.extractedColors, state.palette),
        candidateCount: response.candidateCount,
        matchCount: flat.length,
        highCount: counts.high,
        mediumCount: counts.medium,
        durationMs,
        cached,
      });
    };

    const session = getPhotoMatchSession();
    const cached = session?.image === prepared ? session.responses.get(key) : undefined;
    if (cached) {
      setResult({ key, response: cached });
      setStatus("done");
      setError(null);
      report(cached, true);
      return;
    }

    setStatus("processing");
    setError(null);
    const started = performance.now();
    try {
      const raw = await matchPolishesToImage(prepared.dataUrl, { ...MATCH_REQUEST, ...toMatchRequestOptions(state) });
      if (requestId !== requestIdRef.current) return;
      const response = shareResponsePolishes(raw);
      rememberPhotoMatchResponse(prepared, key, response);
      setResult({ key, response });
      setStatus("done");
      report(response, false, performance.now() - started);
    } catch (err: unknown) {
      if (requestId !== requestIdRef.current) return;
      setError(err instanceof Error ? err.message : "Failed to match colors");
      setStatus("error");
    }
  }, []);

  // Match whenever the photo or a server-side filter changes and there is no result for it yet.
  const resultKey = result?.key ?? null;
  useEffect(() => {
    if (!image || resultKey === requestKey) return;
    const trigger = triggerRef.current;
    triggerRef.current = "filters";
    void runMatch(image, trigger);
  }, [image, requestKey, resultKey, runMatch]);

  const showPhoto = useCallback(
    (prepared: DownscaledImage, full: DownscaledImage | null, trigger: MatchImageTrigger) => {
      startPhotoMatchSession(prepared, full);
      triggerRef.current = trigger;
      setRegion(null);
      setResult(null);
      setFullImage(full);
      setImage(prepared);
      // Dropped / kept chips describe the previous palette.
      setPalette((prev) => ({ ...DEFAULT_PALETTE_SELECTION, showAll: prev.showAll }));
    },
    [setPalette]
  );

  const handleFile = useCallback(
    async (file: File, source: ImageSource) => {
      requestIdRef.current += 1;
      setPreparing(true);
      setError(null);
      try {
        const prepared = await downscaleImageFile(file);
        showPhoto(prepared, null, source);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Couldn't read that image");
        setStatus("error");
        if (!image) setImage(null);
      } finally {
        setPreparing(false);
      }
    },
    [image, showPhoto]
  );

  const handleMatchRegion = useCallback(async () => {
    if (!image || !region) return;
    try {
      const crop = await cropDownscaledImage(image, region);
      showPhoto(crop, fullImage ?? image, "region");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Couldn't crop that area");
    }
  }, [image, region, fullImage, showPhoto]);

  const handleUseWholePhoto = useCallback(() => {
    if (fullImage) showPhoto(fullImage, null, "region");
  }, [fullImage, showPhoto]);

  const reset = useCallback(() => {
    requestIdRef.current += 1;
    clearPhotoMatchSession();
    setImage(null);
    setFullImage(null);
    setRegion(null);
    setResult(null);
    setError(null);
    setStatus("idle");
    setPalette(() => DEFAULT_PALETTE_SELECTION);
  }, [setPalette]);

  // ── Derived view ───────────────────────────────────────────────────────────
  const response = result?.key === requestKey ? result.response : null;
  const palette = useMemo(() => response?.extractedColors ?? [], [response]);
  const active = useMemo(() => activePaletteColors(palette, urlState.palette), [palette, urlState.palette]);
  const groups = useMemo(
    () => (response ? activeColorGroups(response.colorMatches, active) : []),
    [response, active]
  );
  const flat = useMemo(
    () => (response ? rankFlatMatches(response.colorMatches, active, FLAT_LIMIT) : []),
    [response, active]
  );
  const chipCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const group of response?.colorMatches ?? []) {
      counts.set(group.hex.toUpperCase(), group.matches.filter((m) => m.confidence !== "low").length);
    }
    return counts;
  }, [response]);
  const hiddenCount = hiddenByDefaultCount(palette, urlState.palette);
  const anyDefaultHidden = useMemo(
    () => hiddenByDefaultCount(palette, { ...urlState.palette, showAll: false, keep: [] }) > 0,
    [palette, urlState.palette]
  );

  // ── Row actions (optimistic, with the add guard) ───────────────────────────
  const responseRef = useRef(response);
  useEffect(() => {
    responseRef.current = response;
  }, [response]);
  const [pendingById, setPendingById] = useState<Record<string, boolean>>({});
  const { guardAdd, active: activeGuard, choose: chooseGuard, isChecking } = useAddGuard();
  const { finishTypes } = useReferenceData();
  const finishOptions = useMemo(() => buildFinishOptions(finishTypes), [finishTypes]);

  const applyResponse = useCallback((update: (prev: PolishImageMatchResponse) => PolishImageMatchResponse) => {
    setResult((prev) => {
      if (!prev) return prev;
      const next = update(prev.response);
      if (next === prev.response) return prev;
      const session = getPhotoMatchSession();
      if (session) {
        rememberPhotoMatchResponse(session.image, prev.key, next);
        forgetOtherPhotoMatchResponses(prev.key);
      }
      return { key: prev.key, response: next };
    });
  }, []);

  const sendUpdate = useCallback(
    (original: Polish, optimistic: Polish, send: () => Promise<Polish>, onSuccess?: (updated: Polish) => void) => {
      const id = original.id;
      applyResponse((prev) => replacePolishInResponse(prev, id, optimistic, original));
      setPendingById((prev) => ({ ...prev, [id]: true }));
      send()
        .then((updated) => {
          const server = keepRowExtras(updated, original);
          applyResponse((prev) => replacePolishInResponse(prev, id, server, optimistic));
          onSuccess?.(server);
        })
        .catch((err: unknown) => {
          applyResponse((prev) => replacePolishInResponse(prev, id, original, optimistic));
          const reason = err instanceof Error && err.message ? `: ${err.message}` : "";
          toast.error(`Couldn’t update ${original.brand} ${original.name}${reason}`);
        })
        .finally(() =>
          setPendingById((prev) => {
            const next = { ...prev };
            delete next[id];
            return next;
          })
        );
    },
    [applyResponse]
  );

  const onArchivedToastUpdate = useCallback(
    (updated: Polish) =>
      applyResponse((prev) => {
        const current = findPolishInResponse(prev, updated.id);
        return current ? replacePolishInResponse(prev, updated.id, keepRowExtras(updated, current)) : prev;
      }),
    [applyResponse]
  );

  const runAction = useCallback(
    (original: Polish, action: CollectionAction, source: QuickActionSource) => {
      const request = collectionActionRequest(original, action);
      if (!request) return;
      const optimistic = optimisticPolish(original, action);
      sendUpdate(
        original,
        optimistic,
        () =>
          request.method === "delete"
            ? deletePolish(original.id).then(() => optimistic)
            : updatePolish(original.id, request.body),
        (updated) => {
          if (action.kind === "set-tried") {
            trackEvent("collection.tried_changed", { tried: action.date !== null, via: source });
            return;
          }
          trackEvent("collection.status_changed", statusChangeEvent(original.status, optimistic.status ?? null, source));
          if (action.kind === "set-status" && action.status === "wishlist") {
            toast.success("Added to wishlist", { description: `${original.brand} ${original.name} is on your wishlist.` });
          } else if (action.kind === "set-status" && action.status === "owned") {
            toast.success("Added to your collection", { description: `${original.brand} ${original.name}` });
          }
          if (action.kind === "set-status" && isArchivingChange(original, action)) {
            showArchivedToast({ polish: updated, onUpdated: onArchivedToastUpdate });
          }
        }
      );
    },
    [sendUpdate, onArchivedToastUpdate]
  );

  const handleAction = useCallback(
    (match: PolishMatch, rank: number, action: CollectionAction, source: QuickActionSource) => {
      const current = responseRef.current;
      const original = current ? findPolishInResponse(current, match.polish.id) : null;
      if (!original || pendingById[original.id]) return;

      const state = urlStateRef.current;
      trackMatchResultAction({
        action: resultActionFor(action),
        scope: state.scope,
        view: state.view,
        confidence: match.confidence,
        rank,
        fromStatus: original.status,
      });

      // Add guard (#266): "✓ Own" / "♡ wishlist" on a shade the user does not own yet shows its
      // owned near-dupes first, exactly as on /polishes.
      const intent: AddGuardIntent | null =
        action.kind === "set-status" && !isOwnedPolish(original) && action.status !== original.status
          ? action.status === "owned"
            ? "own"
            : action.status === "wishlist"
              ? "wishlist"
              : null
          : null;
      if (!intent) {
        runAction(original, action, source);
        return;
      }
      void guardAdd({
        guardKey: shadeGuardKey(original.id),
        shadeLabel: `${original.brand} ${original.name}`,
        status: original.status,
        intent,
        surface: "photo-match",
        loadDupes: () => getPolishDupes(original.id),
        proceed: (finalIntent) =>
          runAction(original, finalIntent === "wishlist" ? { kind: "set-status", status: "wishlist" } : action, source),
      });
    },
    [pendingById, guardAdd, runAction]
  );

  const handleQuantity = useCallback(
    (match: PolishMatch, rank: number, delta: number) => {
      const current = responseRef.current;
      const original = current ? findPolishInResponse(current, match.polish.id) : null;
      if (!original || pendingById[original.id]) return;
      const state = urlStateRef.current;
      trackMatchResultAction({
        action: "quantity",
        scope: state.scope,
        view: state.view,
        confidence: match.confidence,
        rank,
        fromStatus: original.status,
      });
      const change = quantityChangeUpdate(original, delta);
      sendUpdate(original, applyInventoryPatch(original, change), () => updatePolish(original.id, change), (updated) => {
        if (isArchivingChange(original, change)) showArchivedToast({ polish: updated, onUpdated: onArchivedToastUpdate });
      });
    },
    [pendingById, sendUpdate, onArchivedToastUpdate]
  );

  const handleOpen = useCallback((match: PolishMatch, rank: number) => {
    const state = urlStateRef.current;
    trackMatchResultAction({
      action: "open",
      scope: state.scope,
      view: state.view,
      confidence: match.confidence,
      rank,
      fromStatus: match.polish.status,
    });
  }, []);

  const renderActions = useCallback(
    (match: PolishMatch, rank: number) => (
      <CollectionQuickActions
        polish={match.polish}
        pending={Boolean(pendingById[match.polish.id]) || isChecking(shadeGuardKey(match.polish.id))}
        onAction={(action, source) => handleAction(match, rank, action, source)}
        onQuantityChange={(delta) => handleQuantity(match, rank, delta)}
      />
    ),
    [pendingById, isChecking, handleAction, handleQuantity]
  );

  // ── Render ─────────────────────────────────────────────────────────────────
  const filtersActive = hasMatchFilters(urlState);
  const clearFilters = () => setUrlState((prev) => ({ ...prev, finish: "all", families: [] }));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="heading-page">Match from Photo</h1>
          <p className="text-muted-foreground">
            Upload a photo and find polishes that match its colors — in your collection, on your wishlist, or in the
            whole catalog.
          </p>
        </div>
        <Button asChild variant="outline">
          <Link href="/polishes/search">Open Color Search</Link>
        </Button>
      </div>

      {ownedCount === 0 && !image && !preparing && (
        <EmptyState
          icon={ImageUp}
          title="Photo matching needs a collection"
          description="Upload a photo and this page finds the polishes you own in its colors, so add a few polishes first."
          actionLabel="Search the catalog"
          actionHref={CATALOG_SEARCH_HREF}
          onAction={() => trackOnboardingStepClicked({ step: "search", surface: "match_empty", ownedCount: 0 })}
        />
      )}

      {ownedCount !== 0 && !image && !preparing && (
        <>
          <ImageDropZone onFile={handleFile} />
          {status === "error" && error && (
            <ErrorState title="Couldn't use that image" message={error} className="min-h-0 py-2" />
          )}
        </>
      )}

      {!image && preparing && <BrandSpinner label="Preparing photo…" />}

      {image && (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
          <Card className="relative h-fit overflow-hidden border border-brand-purple/20 bg-card/95">
            <span className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-brand-pink-soft via-brand-lilac to-brand-purple" />
            <CardHeader className="flex flex-row items-start justify-between gap-2">
              <div>
                <CardTitle>Your photo</CardTitle>
                <CardDescription>Analyzed in memory, never saved.</CardDescription>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Clear photo"
                title="Clear photo"
                onClick={reset}
              >
                <X />
              </Button>
            </CardHeader>
            <CardContent className="space-y-4">
              <RegionPreview
                src={image.dataUrl}
                width={image.width}
                height={image.height}
                region={region}
                onRegionChange={setRegion}
                disabled={status === "processing" || preparing}
              />
              <RegionControls
                region={region}
                focused={fullImage !== null}
                disabled={status === "processing" || preparing}
                onMatchRegion={handleMatchRegion}
                onClearRegion={() => setRegion(null)}
                onUseWholePhoto={handleUseWholePhoto}
              />
              <ImageDropZone onFile={handleFile} disabled={status === "processing" || preparing} compact />
            </CardContent>
          </Card>

          <Card className="relative overflow-hidden border border-brand-purple/20 bg-card/95">
            <span className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-brand-pink-soft via-brand-lilac to-brand-purple" />
            <CardHeader className="space-y-3">
              <div>
                <CardTitle>{SCOPE_TITLES[urlState.scope]}</CardTitle>
                <CardDescription>Tap a color to stop matching it, or tap it again to bring it back.</CardDescription>
              </div>
              <MatchFilters
                state={urlState}
                finishOptions={finishOptions}
                onScope={setScope}
                onFinish={setFinish}
                onFamilies={setFamilies}
                onView={setView}
                onClear={filtersActive ? clearFilters : undefined}
              />
            </CardHeader>
            <CardContent className="space-y-4">
              {status === "processing" && (
                <BrandSpinner label="Finding matching polishes…" className="min-h-[240px]" />
              )}

              {status === "error" && error && (
                <ErrorState
                  message={error}
                  onRetry={() => void runMatch(image, "filters")}
                  className="min-h-[240px]"
                />
              )}

              {status === "done" && response && (
                <>
                  {palette.length > 0 && (
                    <div className="space-y-2">
                      <ExtractedPalette
                        colors={palette}
                        selection={urlState.palette}
                        matchCounts={chipCounts}
                        onToggle={(hex) => setPalette((prev) => togglePaletteColor(hex, palette, prev))}
                      />
                      <PaletteHint
                        hiddenCount={hiddenCount}
                        showAll={urlState.palette.showAll}
                        anyDefaultHidden={anyDefaultHidden}
                        onShowAll={(showAll) => setPalette((prev) => ({ ...prev, showAll }))}
                      />
                    </div>
                  )}

                  <MatchResultsBody
                    response={response}
                    view={urlState.view}
                    scope={urlState.scope}
                    filtersActive={filtersActive}
                    activeCount={active.length}
                    groups={groups}
                    flat={flat}
                    renderActions={renderActions}
                    onOpen={handleOpen}
                    onClearFilters={clearFilters}
                    onScope={setScope}
                    onResetPalette={() => setPalette(() => DEFAULT_PALETTE_SELECTION)}
                  />
                </>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      <AddGuardDialog guard={activeGuard} onChoice={chooseGuard} returnTo="/polishes/match" />
    </div>
  );
}

// ── Filters ──────────────────────────────────────────────────────────────────

function MatchFilters({
  state,
  finishOptions,
  onScope,
  onFinish,
  onFamilies,
  onView,
  onClear,
}: {
  state: PhotoMatchUrlState;
  finishOptions: Array<{ value: string; label: string }>;
  onScope: (scope: MatchScope) => void;
  onFinish: (finish: string) => void;
  onFamilies: (families: PhotoMatchUrlState["families"]) => void;
  onView: (view: MatchView) => void;
  onClear?: () => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Match against" className="flex flex-wrap gap-1.5">
          {MATCH_SCOPE_OPTIONS.map((option) => (
            <ToggleChip
              key={option.value}
              pressed={state.scope === option.value}
              onPressedChange={() => onScope(option.value)}
              className="h-8 px-3 text-xs"
            >
              {option.label}
            </ToggleChip>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Select value={state.finish} onValueChange={onFinish}>
            <SelectTrigger size="sm" className="w-[150px]" aria-label="Finish">
              <SelectValue placeholder="Finish" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All finishes</SelectItem>
              {finishOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div role="group" aria-label="Results view" className="flex gap-1">
            <ToggleChip pressed={state.view === "colors"} onPressedChange={() => onView("colors")} className="h-8 px-3 text-xs">
              Per color
            </ToggleChip>
            <ToggleChip pressed={state.view === "list"} onPressedChange={() => onView("list")} className="h-8 px-3 text-xs">
              All matches
            </ToggleChip>
          </div>
        </div>
      </div>
      <details className="group" open={state.families.length > 0 || undefined}>
        <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
          Color family{state.families.length > 0 ? ` (${state.families.length})` : ""}
          {onClear && (
            <button
              type="button"
              className="ml-3 font-medium text-brand-purple underline-offset-4 hover:underline dark:text-brand-lilac"
              onClick={(event) => {
                event.preventDefault();
                onClear();
              }}
            >
              Clear filters
            </button>
          )}
        </summary>
        <ColorFamilyChips value={state.families} onChange={onFamilies} className="mt-2" />
      </details>
    </div>
  );
}

function PaletteHint({
  hiddenCount,
  showAll,
  anyDefaultHidden,
  onShowAll,
}: {
  hiddenCount: number;
  showAll: boolean;
  anyDefaultHidden: boolean;
  onShowAll: (showAll: boolean) => void;
}) {
  if (!anyDefaultHidden) return null;
  const linkClass = "font-medium text-brand-purple underline-offset-4 hover:underline dark:text-brand-lilac";
  return (
    <p className="text-xs text-muted-foreground">
      {showAll ? (
        <>
          Background and skin colors are included.{" "}
          <button type="button" className={linkClass} onClick={() => onShowAll(false)}>
            Hide them
          </button>
        </>
      ) : hiddenCount > 0 ? (
        <>
          {hiddenCount} background or skin {hiddenCount === 1 ? "color is" : "colors are"} left out.{" "}
          <button type="button" className={linkClass} onClick={() => onShowAll(true)}>
            Show all colors
          </button>
        </>
      ) : null}
    </p>
  );
}

// ── Results ──────────────────────────────────────────────────────────────────

const TIPS = "Try a closer crop (drag across the photo), daylight instead of a lamp or flash, and a plain background.";

function MatchResultsBody({
  response,
  view,
  scope,
  filtersActive,
  activeCount,
  groups,
  flat,
  renderActions,
  onOpen,
  onClearFilters,
  onScope,
  onResetPalette,
}: {
  response: PolishImageMatchResponse;
  view: MatchView;
  scope: MatchScope;
  filtersActive: boolean;
  activeCount: number;
  groups: ColorMatchGroup[];
  flat: PolishMatch[];
  renderActions: (match: PolishMatch, rank: number) => React.ReactNode;
  onOpen: (match: PolishMatch, rank: number) => void;
  onClearFilters: () => void;
  onScope: (scope: MatchScope) => void;
  onResetPalette: () => void;
}) {
  const reason = matchEmptyReason({
    paletteSize: response.extractedColors.length,
    candidateCount: response.candidateCount,
    activeColorCount: activeCount,
    matches: flat,
  });
  const linkClass = "font-medium text-brand-purple underline-offset-4 hover:underline dark:text-brand-lilac";

  if (reason === "no-colors") {
    return (
      <MatchEmptyState title="We couldn’t find any colors in that photo" description={TIPS} />
    );
  }

  if (reason === "no-candidates") {
    if (filtersActive) {
      return (
        <MatchEmptyState
          title="Nothing matches these filters"
          description="No polishes with a known color have this finish or color family here."
          actionLabel="Clear filters"
          onAction={onClearFilters}
        />
      );
    }
    if (scope === "owned") {
      return (
        <MatchEmptyState
          title="No colors in your collection yet"
          description="Add polishes (with a known color) to match them against photos, or search the whole catalog instead."
          actionLabel="Search the catalog"
          onAction={() => onScope("catalog")}
          linkLabel="+ Add Polish"
          linkHref="/polishes/new"
        />
      );
    }
    if (scope === "wishlist") {
      return (
        <MatchEmptyState
          title="Your wishlist has no polishes with a known color"
          description="Search the whole catalog and ♡ the ones you like."
          actionLabel="Search the catalog"
          onAction={() => onScope("catalog")}
        />
      );
    }
    return (
      <MatchEmptyState
        title="No catalog shades have a known color yet"
        description="Catalog colors fill in as brands are imported. Try again later."
      />
    );
  }

  if (reason === "no-active-colors") {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        You took every color out of matching.{" "}
        <button type="button" className={linkClass} onClick={onResetPalette}>
          Use the photo’s colors again
        </button>
      </p>
    );
  }

  const counts = confidenceCounts(flat);
  const nounByScope: Record<MatchScope, string> = { owned: "owned", wishlist: "wishlisted", catalog: "catalog" };

  return (
    <div className="space-y-4">
      <ConfidenceLegend counts={counts} />

      {reason === "only-loose" && (
        <div className="rounded-lg border border-dashed border-amber-300 bg-amber-50/60 px-3 py-2 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
          <p className="font-medium">Nothing close yet.</p>
          <p className="text-xs">
            {TIPS}
            {scope !== "catalog" && (
              <>
                {" "}Or{" "}
                <button type="button" className={linkClass} onClick={() => onScope("catalog")}>
                  search the whole catalog
                </button>
                .
              </>
            )}
          </p>
        </div>
      )}

      {view === "list" ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Top {flat.length} of {response.candidateCount} {nounByScope[scope]}{" "}
            {response.candidateCount === 1 ? "polish" : "polishes"}, closest first (ties go to the color covering more of
            the photo)
          </p>
          <MatchResultsList matches={flat} renderActions={renderActions} onOpen={onOpen} />
        </div>
      ) : (
        <div className="space-y-5">
          {groups.map((group) => (
            <ColorGroupSection
              key={group.hex}
              group={group}
              fraction={response.extractedColors.find((c) => c.hex === group.hex)?.fraction ?? 0}
              renderActions={renderActions}
              onOpen={onOpen}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ColorGroupSection({
  group,
  fraction,
  renderActions,
  onOpen,
}: {
  group: ColorMatchGroup;
  fraction: number;
  renderActions: (match: PolishMatch, rank: number) => React.ReactNode;
  onOpen: (match: PolishMatch, rank: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? group.matches : group.matches.slice(0, GROUP_PREVIEW);
  const more = group.matches.length - shown.length;
  return (
    <section aria-label={`Matches for ${group.hex}`} className="space-y-1">
      <header className="flex items-center gap-2">
        <ColorDot hex={group.hex} size="md" />
        <h3 className="text-sm font-semibold tabular-nums">{group.hex}</h3>
        <span className="text-xs text-muted-foreground">{formatFraction(fraction)} of photo</span>
      </header>
      {group.matches.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">No polishes to compare with this color.</p>
      ) : (
        <MatchResultsList matches={shown} renderActions={renderActions} onOpen={onOpen} hideMatchedColor />
      )}
      {(more > 0 || expanded) && group.matches.length > GROUP_PREVIEW && (
        <button
          type="button"
          className="ml-2 text-xs font-medium text-brand-purple underline-offset-4 hover:underline dark:text-brand-lilac"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show fewer" : `Show ${more} more`}
        </button>
      )}
    </section>
  );
}
