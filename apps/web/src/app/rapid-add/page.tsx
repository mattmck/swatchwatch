"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { CaptureFrameType, FinishName } from "swatchwatch-shared";
import type { CaptureCheckResponse } from "swatchwatch-shared";
import { AlertCircle, CircleCheck, Loader2, Search } from "lucide-react";
import {
  addCaptureFrame,
  answerCaptureQuestion,
  checkCapture,
  finalizeCapture,
  getCaptureStatus,
  listAllPolishes,
  startCapture,
  updatePolish,
} from "@/lib/api";
import { buildFinishOptions } from "@/lib/finish-options";
import { useReferenceData } from "@/hooks/use-reference-data";
import { trackEvent } from "@/lib/telemetry";
import {
  buildOwnershipSnapshot,
  ownedEntryAfterVerdict,
  resolveCaptureVerdict,
  verdictFromCheck,
  withOwnedEntry,
  type CaptureVerdict,
  type OwnershipSnapshot,
} from "@/lib/capture-verdict";
import {
  buildFrameQuality,
  buildStartMetadata,
  canAddFrame,
  canFinalize,
  framesReducer,
  INITIAL_SESSION_STATE,
  MAX_CAPTURE_FRAMES,
  rapidAddPhase,
  scanBadge,
  sessionReducer,
  summarizeFrames,
  type CaptureFrameEntry,
  type QuestionAction,
} from "@/lib/rapid-add-flow";
import { assessFrameQuality, FRAME_QUALITY_WARNING_COPY } from "@/lib/camera";
import type { ScannedBarcode } from "@/lib/barcode-scan";
import { CameraCapture, type CameraCaptureEvent } from "@/components/rapid-add/camera-capture";
import { FrameStrip } from "@/components/rapid-add/frame-strip";
import { CaptureQuestionPanel } from "@/components/rapid-add/capture-question-panel";
import { VerdictCard } from "@/components/rapid-add/verdict-card";
import { InstallPrompt } from "@/components/install-prompt";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * A freshly decoded barcode is checked right away (its frame's upload response carries the
 * verdict, no OCR; without a frame, one `check` call). Not once a verdict is showing or the
 * user is photographing the label for an unknown barcode.
 */
function shouldCheckBarcode(
  session: { labelRequested: boolean; verdict: unknown },
  barcode: ScannedBarcode | null,
): barcode is ScannedBarcode {
  return Boolean(barcode) && !session.labelRequested && !session.verdict;
}

function newLocalId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function RapidAddPage() {
  const { finishTypes } = useReferenceData();
  const finishOptions = useMemo(() => buildFinishOptions(finishTypes), [finishTypes]);

  const [brandHint, setBrandHint] = useState("");
  const [shadeHint, setShadeHint] = useState("");
  const [finishHint, setFinishHint] = useState<FinishName | "">("");
  const [collectionHint, setCollectionHint] = useState("");
  const [frameType, setFrameType] = useState<CaptureFrameType>("label");
  const [qualityHint, setQualityHint] = useState<string | null>(null);

  const [session, dispatch] = useReducer(sessionReducer, INITIAL_SESSION_STATE);
  const [frames, dispatchFrames] = useReducer(framesReducer, []);
  const phase = rapidAddPhase(session);
  const frameSummary = summarizeFrames(frames);
  const hasHints = Boolean(brandHint.trim() || shadeHint.trim());

  // Latest values for async callbacks that outlive a render.
  const sessionRef = useRef(session);
  const framesRef = useRef(frames);
  const hintsRef = useRef({ brand: brandHint, shadeName: shadeHint, finish: finishHint, collection: collectionHint });
  useEffect(() => {
    sessionRef.current = session;
    framesRef.current = frames;
    hintsRef.current = { brand: brandHint, shadeName: shadeHint, finish: finishHint, collection: collectionHint };
  });

  // One capture session per scanned item; concurrent frames share the same start request.
  const sessionPromiseRef = useRef<Promise<string> | null>(null);
  const cameraSectionRef = useRef<HTMLDivElement | null>(null);

  // Ownership snapshot of the collection, taken before finalize adds the match to it.
  const snapshotRef = useRef<Promise<OwnershipSnapshot | null> | null>(null);
  const loadSnapshot = useCallback(() => {
    snapshotRef.current = listAllPolishes({ scope: "collection" })
      .then((polishes) => buildOwnershipSnapshot(polishes))
      .catch(() => null);
    return snapshotRef.current;
  }, []);
  useEffect(() => {
    void loadSnapshot();
  }, [loadSnapshot]);

  const ensureSession = useCallback(async (barcode: ScannedBarcode | null): Promise<string> => {
    if (sessionRef.current.captureId) return sessionRef.current.captureId;
    if (!sessionPromiseRef.current) {
      dispatch({ type: "busy", busy: "starting" });
      sessionPromiseRef.current = startCapture({
        metadata: buildStartMetadata({ barcode: barcode ?? sessionRef.current.barcode, hints: hintsRef.current }),
      }).then(
        (started) => {
          dispatch({ type: "session_started", captureId: started.captureId, status: started.status });
          sessionRef.current = { ...sessionRef.current, captureId: started.captureId, status: started.status };
          return started.captureId;
        },
        (error: unknown) => {
          sessionPromiseRef.current = null;
          throw error;
        },
      );
    }
    return sessionPromiseRef.current;
  }, []);

  /** Show the verdict for a scanned barcode from a check response (nothing is added yet). */
  const showCheckVerdict = useCallback((check: CaptureCheckResponse, barcode: ScannedBarcode) => {
    const verdict = verdictFromCheck(check, barcode);
    dispatch({ type: "verdict_resolved", verdict });
    if (verdict) {
      trackEvent("rapid_add.verdict", {
        kind: verdict.kind,
        relationship: verdict.kind === "checked" ? verdict.relationship : null,
        barcodeEngine: barcode.engine,
        frames: framesRef.current.length,
      });
    }
  }, []);

  const checkBarcode = useCallback(
    async (captureId: string, barcode: ScannedBarcode, check?: CaptureCheckResponse) => {
      try {
        dispatch({ type: "busy", busy: "checking" });
        showCheckVerdict(check ?? (await checkCapture(captureId)), barcode);
      } catch (error) {
        dispatch({
          type: "failed",
          error: `Couldn't check that barcode: ${errorMessage(error, "network error")}. Tap Find match.`,
        });
      }
    },
    [showCheckVerdict],
  );

  const uploadFrame = useCallback(
    async (frame: Pick<CaptureFrameEntry, "localId" | "frameType" | "dataUrl" | "quality">, barcode: ScannedBarcode | null) => {
      try {
        const captureId = await ensureSession(barcode);
        const checking = frame.frameType === "barcode" && shouldCheckBarcode(sessionRef.current, barcode);
        if (checking) dispatch({ type: "busy", busy: "checking" });
        const res = await addCaptureFrame(captureId, {
          frameType: frame.frameType,
          imageBlobUrl: frame.dataUrl,
          quality: frame.quality,
        });
        dispatchFrames({ type: "upload_succeeded", localId: frame.localId, frameId: res.frameId });
        if (checking && barcode) await checkBarcode(captureId, barcode, res.check);
      } catch (error) {
        dispatchFrames({
          type: "upload_failed",
          localId: frame.localId,
          error: errorMessage(error, "Upload failed"),
        });
        dispatch({ type: "failed", error: `Couldn't upload a frame: ${errorMessage(error, "network error")}. Tap Retry on it.` });
      }
    },
    [ensureSession, checkBarcode],
  );

  const handleCapture = useCallback(
    (event: CameraCaptureEvent) => {
      const current = sessionRef.current;
      if (rapidAddPhase(current) === "verdict" || rapidAddPhase(current) === "resolving") return;
      if (event.barcode) {
        dispatch({ type: "barcode_detected", barcode: event.barcode });
        sessionRef.current = { ...sessionRef.current, barcode: event.barcode };
      }
      if (!event.frame) {
        // Read live but no snapshot: check the barcode from the session metadata alone.
        const barcode = event.barcode;
        if (shouldCheckBarcode(sessionRef.current, barcode)) {
          dispatch({ type: "busy", busy: "checking" });
          void ensureSession(barcode).then(
            (captureId) => checkBarcode(captureId, barcode),
            (error: unknown) => dispatch({ type: "failed", error: errorMessage(error, "Couldn't start the scan.") }),
          );
        }
        return;
      }
      if (!canAddFrame(framesRef.current)) {
        dispatch({ type: "failed", error: `That's the most frames for one scan (${MAX_CAPTURE_FRAMES}). Tap Find match.` });
        return;
      }
      const warnings = assessFrameQuality(event.frame.metrics);
      setQualityHint(warnings.length ? FRAME_QUALITY_WARNING_COPY[warnings[0]] : null);

      const frame = {
        localId: newLocalId(),
        frameType: event.frameType,
        dataUrl: event.frame.dataUrl,
        quality: buildFrameQuality({
          source: event.source,
          width: event.frame.width,
          height: event.frame.height,
          sourceWidth: event.frame.sourceWidth,
          sourceHeight: event.frame.sourceHeight,
          metrics: event.frame.metrics,
          barcode: event.barcode,
          fileName: event.file?.name,
          mimeType: event.file?.type,
          fileSize: event.file?.size,
        }),
      };
      framesRef.current = [...framesRef.current, { ...frame, status: "uploading", attempts: 1 }];
      dispatchFrames({ type: "added", frame });
      void uploadFrame(frame, event.barcode ?? sessionRef.current.barcode);
    },
    [uploadFrame, ensureSession, checkBarcode],
  );

  function handleRetryFrame(localId: string) {
    const frame = frames.find((f) => f.localId === localId);
    if (!frame) return;
    dispatchFrames({ type: "upload_started", localId });
    dispatch({ type: "error_dismissed" });
    void uploadFrame(frame, session.barcode);
  }

  async function resolveVerdict(captureId: string, displayHint?: string) {
    const status = await getCaptureStatus(captureId);
    dispatch({
      type: "outcome_received",
      outcome: {
        status: status.status,
        acceptedEntityType: status.acceptedEntityType,
        acceptedEntityId: status.acceptedEntityId,
        metadata: status.metadata,
      },
    });
    if (status.status === "needs_question") {
      dispatch({ type: "status_received", status: status.status, question: status.question });
      return;
    }
    const snapshot = await (snapshotRef.current ?? loadSnapshot());
    const verdict = await resolveCaptureVerdict(status, snapshot, { displayHint });
    dispatch({ type: "verdict_resolved", verdict });
    if (verdict) {
      trackEvent("rapid_add.verdict", {
        kind: verdict.kind,
        barcodeEngine: sessionRef.current.barcode?.engine ?? null,
        frames: framesRef.current.length,
      });
      const entry = ownedEntryAfterVerdict(verdict);
      if (entry && snapshot) {
        snapshotRef.current = Promise.resolve(withOwnedEntry(snapshot, entry));
      }
    }
  }

  /** The match is saved but loading its verdict failed: fetch the result again. */
  async function handleRetryResolve() {
    const captureId = session.captureId;
    if (!captureId) return;
    dispatch({ type: "busy", busy: "resolving" });
    try {
      await resolveVerdict(captureId);
    } catch (error) {
      dispatch({ type: "failed", error: errorMessage(error, "Couldn't load the result. Try again.") });
    }
  }

  async function handleFinalize() {
    dispatch({ type: "busy", busy: "finalizing" });
    try {
      const captureId = await ensureSession(session.barcode);
      dispatch({ type: "busy", busy: "finalizing" });
      const res = await finalizeCapture(captureId);
      dispatch({ type: "status_received", status: res.status, question: res.question });
      if (res.status === "matched" || res.status === "unmatched") {
        await resolveVerdict(captureId);
      }
    } catch (error) {
      dispatch({ type: "failed", error: errorMessage(error, "Matching failed. Try again.") });
    }
  }

  async function handleAnswer(answer: string, displayHint?: string) {
    const captureId = session.captureId;
    if (!captureId || !session.question) return;
    dispatch({ type: "busy", busy: "answering" });
    try {
      const res = await answerCaptureQuestion(captureId, { questionId: session.question.id, answer });
      dispatch({ type: "status_received", status: res.status, question: res.question });
      if (res.status === "matched" || res.status === "unmatched") {
        await resolveVerdict(captureId, displayHint);
      }
    } catch (error) {
      dispatch({ type: "failed", error: errorMessage(error, "Couldn't send that answer. Try again.") });
    }
  }

  /** Unknown barcode → label photo, in the same session so the barcode is learned on the match. */
  function handlePhotographLabel() {
    dispatch({ type: "label_requested" });
    setFrameType("label");
    cameraSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function handleAddToWishlist(verdict: CaptureVerdict) {
    if (verdict.kind !== "checked" || !verdict.shadeId) return;
    dispatch({ type: "busy", busy: "wishlisting" });
    try {
      await updatePolish(verdict.shadeId, { status: "wishlist" });
      dispatch({ type: "verdict_resolved", verdict: { ...verdict, relationship: "wishlisted", wishlistedNow: true } });
    } catch (error) {
      dispatch({ type: "failed", error: errorMessage(error, "Couldn't add it to your wishlist.") });
    }
  }

  function handleQuestionAction(action: QuestionAction) {
    setFrameType(action === "scan_barcode" ? "barcode" : "label");
    cameraSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function handleUndoQuantity() {
    const verdict = session.verdict;
    if (verdict?.kind !== "owned" || !verdict.shadeId) return;
    dispatch({ type: "busy", busy: "undoing" });
    try {
      await updatePolish(verdict.shadeId, { quantity: verdict.previousQuantity });
      dispatch({ type: "quantity_restored" });
      const snapshot = await snapshotRef.current;
      if (snapshot) {
        snapshotRef.current = Promise.resolve(
          withOwnedEntry(snapshot, {
            inventoryItemId: verdict.inventoryItemId,
            shadeId: verdict.shadeId,
            brand: "",
            name: verdict.display,
            quantity: verdict.previousQuantity,
            hex: verdict.hex,
          }),
        );
      }
    } catch (error) {
      dispatch({ type: "failed", error: errorMessage(error, "Couldn't update the quantity.") });
    }
  }

  function handleScanNext() {
    sessionPromiseRef.current = null;
    dispatch({ type: "reset" });
    dispatchFrames({ type: "reset" });
    sessionRef.current = INITIAL_SESSION_STATE;
    framesRef.current = [];
    setQualityHint(null);
    setFrameType("label");
  }

  const finalizeEnabled = canFinalize({ frames, session, hasHints });
  const badge = phase === "verdict" ? null : scanBadge(session);
  const scanning = phase !== "verdict" && phase !== "resolving" && !session.barcode;
  const busy = session.busy !== null;
  const hintsLocked = session.captureId !== null;

  return (
    <div className="mx-auto max-w-3xl space-y-5 pb-16">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="heading-page">Rapid Add</h1>
          <p className="text-muted-foreground">
            Scan a bottle to see if you already own it — or add it in one tap.
          </p>
        </div>
        <Button asChild variant="outline">
          <Link href="/polishes/new">Manual Add</Link>
        </Button>
      </div>

      <InstallPrompt />

      {session.verdict && (
        <VerdictCard
          verdict={session.verdict}
          quantityRestored={session.quantityRestored}
          undoing={session.busy === "undoing"}
          busy={session.busy}
          onUndoQuantity={() => void handleUndoQuantity()}
          onAddToCollection={() => void handleFinalize()}
          onAddToWishlist={(verdict) => void handleAddToWishlist(verdict)}
          onPhotographLabel={handlePhotographLabel}
          onScanNext={handleScanNext}
        />
      )}

      <Card ref={cameraSectionRef} className="scroll-mt-4">
        <CardContent className="space-y-4">
          <CameraCapture
            scanBarcodes={scanning}
            captureDisabled={phase === "verdict" || phase === "resolving" || !canAddFrame(frames)}
            frameType={frameType}
            onFrameTypeChange={setFrameType}
            onCapture={handleCapture}
            onCameraError={(kind) => trackEvent("rapid_add.camera_error", { kind })}
          />

          {badge && (
            <p
              role="status"
              className="flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-100"
            >
              <CircleCheck className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
              <span>
                Scanned <span className="font-mono font-semibold">{badge.gtin}</span>
              </span>
              {badge.checking && (
                <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" aria-hidden /> Checking…
                </span>
              )}
            </p>
          )}
          {session.labelRequested && phase === "collecting" && (
            <p className="text-sm text-muted-foreground">
              Now snap the front label, then tap Find match. We&apos;ll remember this barcode for next time.
            </p>
          )}
          {qualityHint && phase === "collecting" && (
            <p className="text-xs text-amber-700 dark:text-amber-400">{qualityHint}</p>
          )}

          <FrameStrip
            frames={frames}
            onRetry={handleRetryFrame}
            onRemove={(localId) => dispatchFrames({ type: "removed", localId })}
          />
        </CardContent>
      </Card>

      {phase === "question" && session.question && (
        <CaptureQuestionPanel
          key={session.question.id}
          question={session.question}
          busy={busy}
          onAnswer={(answer, displayHint) => void handleAnswer(answer, displayHint)}
          onSkip={() => void handleAnswer("skip")}
          onAction={handleQuestionAction}
        />
      )}

      {phase !== "verdict" && (
        <div className="space-y-2">
          <Button
            type="button"
            variant="brand"
            size="lg"
            className="w-full"
            onClick={() => void handleFinalize()}
            disabled={!finalizeEnabled}
          >
            {session.busy === "finalizing" || session.busy === "resolving" ? (
              <Loader2 className="animate-spin" aria-hidden />
            ) : (
              <Search aria-hidden />
            )}
            {session.busy === "finalizing" || session.busy === "resolving" ? "Matching…" : "Find match"}
          </Button>
          <p className="text-center text-xs text-muted-foreground">
            {frameSummary.uploading > 0
              ? "Uploading frames…"
              : "A match is added to your collection; if you already own it you can undo the extra bottle."}
          </p>
        </div>
      )}

      {session.error && (
        <div role="alert" className="flex flex-wrap items-start gap-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">{session.error}</span>
          {phase === "resolving" && !busy && session.captureId && (
            <Button type="button" variant="outline" size="sm" onClick={() => void handleRetryResolve()}>
              Try again
            </Button>
          )}
        </div>
      )}

      {phase !== "verdict" && (
        <details className="group rounded-xl border border-border/60 p-4">
          <summary className="cursor-pointer text-sm font-medium">Know the name? Add hints</summary>
          <div className="mt-3 space-y-3">
            <p className="text-xs text-muted-foreground">
              {hintsLocked
                ? "Hints are sent when a scan starts; they'll apply to your next scan."
                : "Brand and shade help when there's no barcode. With hints alone, Find match works without a photo."}
            </p>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <Input
                aria-label="Brand hint"
                value={brandHint}
                disabled={hintsLocked}
                onChange={(e) => setBrandHint(e.target.value)}
                placeholder="Brand (e.g. OPI)"
              />
              <Input
                aria-label="Shade hint"
                value={shadeHint}
                disabled={hintsLocked}
                onChange={(e) => setShadeHint(e.target.value)}
                placeholder="Shade (e.g. Big Apple Red)"
              />
              <Select value={finishHint} onValueChange={(value) => setFinishHint(value)} disabled={hintsLocked}>
                <SelectTrigger aria-label="Finish hint">
                  <SelectValue placeholder="Optional finish hint" />
                </SelectTrigger>
                <SelectContent>
                  {finishOptions.map((finish) => (
                    <SelectItem key={finish.value} value={finish.value}>
                      {finish.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                aria-label="Collection hint"
                value={collectionHint}
                disabled={hintsLocked}
                onChange={(e) => setCollectionHint(e.target.value)}
                placeholder="Collection (optional)"
              />
            </div>
          </div>
        </details>
      )}
    </div>
  );
}
