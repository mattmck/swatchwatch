"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  EMPTY_STICKY_HINTS,
  INITIAL_BOTTLE_FLOW_STATE,
  bottleFlowReducer,
  createPolishRequestFromCard,
  deriveBottleCameraView,
  isBatchMode,
  shouldAutoCheck,
  surfaceFromQuality,
  switchBrand,
  withBrandEcho,
  type BottleFlowAction,
  type BottleSurface,
  type CaptureBrandRef,
  type CaptureCheckCandidate,
  type CaptureCheckResponse,
  type CaptureReadSummary,
  type CaptureFrameType,
  type CreateCardEdits,
  type FinishName,
  type StickyHints,
} from "swatchwatch-shared";
import { AlertCircle, CircleCheck, Loader2, Search } from "lucide-react";
import {
  addCaptureFrame,
  answerCaptureQuestion,
  checkCapture,
  createPolish,
  finalizeCapture,
  getCaptureStatus,
  getCurrentUserId,
  getPolishDupeHints,
  getPolishDupes,
  listAllPolishes,
  startCapture,
  updatePolish,
} from "@/lib/api";
import { buildFinishOptions } from "@/lib/finish-options";
import { useReferenceData } from "@/hooks/use-reference-data";
import { trackEvent } from "@/lib/telemetry";
import {
  NEAR_DUPE_CARD_MAX,
  NEAR_DUPE_OUTCOMES,
  buildOwnershipSnapshot,
  checkedFromNearDupe,
  ownedEntryAfterVerdict,
  resolveCaptureVerdict,
  verdictHeadline,
  resolveNearDupeVerdict,
  verdictFromBottleCheck,
  verdictFromCheck,
  withOwnedEntry,
  type CaptureVerdict,
  type CheckedVerdict,
  type CreateCardVerdict,
  type NearDupeChoice,
  type NearDupeVerdict,
  type OwnershipSnapshot,
  type PickVerdict,
} from "@/lib/capture-verdict";
import {
  bottleAddQuantity,
  bottleEvidence,
  echoMatchesBatch,
  verdictAfterBottleAdd,
  verdictAfterCreate,
  verdictFromPickedCandidate,
  viewForSurface,
} from "@/lib/bottle-rapid-add";
import { readStickyHints, safeLocalStorage, writeStickyHints } from "@/lib/sticky-hints-store";
import { useFeatureFlags } from "@/lib/use-feature-flags";
import {
  ADD_GUARD_EVENTS,
  addGuardTelemetry,
  readSuppressedGuardKeys,
  safeSessionStorage,
  shadeGuardKey,
} from "@/lib/add-guard";
import { trackDupeWarningOutcome, trackDupeWarningShown } from "@/lib/metrics-events";
import {
  buildFrameQuality,
  buildStartMetadata,
  canAddFrame,
  canCheckBarcodeFromMetadata,
  canCheck,
  canFinalize,
  framesReducer,
  INITIAL_SESSION_STATE,
  MAX_CAPTURE_FRAMES,
  planLiveBarcode,
  rapidAddPhase,
  scanBadge,
  sessionReducer,
  summarizeFrames,
  type CaptureFrameEntry,
  type QuestionAction,
} from "@/lib/rapid-add-flow";
import { assessFrameQuality, FRAME_QUALITY_WARNING_COPY } from "@/lib/camera";
import {
  EMPTY_SHELF,
  readShelf,
  safeShelfStorage,
  shelfActionEvent,
  shelfDupeFromHint,
  shelfEntryFromVerdict,
  shelfNeedsDupeCheck,
  shelfReducer,
  shelfStartsEntry,
  shelfStorageKey,
  writeShelf,
  type ShelfEntry,
  type ShelfQuickAction,
  type ShelfTelemetryAction,
} from "@/lib/rapid-add-shelf";
import type { ScannedBarcode } from "@/lib/barcode-scan";
import { BottleReadPanel } from "@/components/rapid-add/bottle-read-panel";
import {
  CameraCapture,
  defaultCameraGuide,
  type CameraCaptureEvent,
  type CameraGuide,
  type ViewfinderStatus,
} from "@/components/rapid-add/camera-capture";
import { FrameStrip } from "@/components/rapid-add/frame-strip";
import { BatchBrandField } from "@/components/rapid-add/batch-brand-field";
import { BottlePromptPanel } from "@/components/rapid-add/bottle-prompt-panel";
import { CaptureQuestionPanel } from "@/components/rapid-add/capture-question-panel";
import { VerdictCard } from "@/components/rapid-add/verdict-card";
import { ShelfList } from "@/components/rapid-add/shelf-list";
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

/** Funnel extras for a near-dupe verdict (no PII: the catalog shade id only). */
function nearDupeDetails(verdict: NearDupeVerdict) {
  return addGuardTelemetry({
    surface: "rapid-add",
    intent: "own",
    guardKey: shadeGuardKey(verdict.shadeId),
    response: verdict.dupes,
  });
}

/** How long a repeat-read or "still checking" message stays over the camera. */
const CAMERA_FLASH_MS = 2500;

export default function RapidAddPage() {
  const { finishTypes } = useReferenceData();
  const finishOptions = useMemo(() => buildFinishOptions(finishTypes), [finishTypes]);
  const flags = useFeatureFlags();
  // Guided bottle sequence (flag on); "More options" falls back to today's chips and finalize.
  const [moreOptions, setMoreOptions] = useState(false);
  const bottleSequence = flags.bottleCapture && !moreOptions;
  const [sticky, setSticky] = useState<StickyHints>(EMPTY_STICKY_HINTS);
  const [bottle, setBottle] = useState(INITIAL_BOTTLE_FLOW_STATE);
  /** What the server has read from this bottle's photos so far (bottle sequence only). */
  const [readSoFar, setReadSoFar] = useState<CaptureReadSummary | null>(null);
  /** A surface the user jumped to with a chip, until the next photo is taken. */
  const [manualSurface, setManualSurface] = useState<BottleSurface | null>(null);

  const [brandHint, setBrandHint] = useState("");
  const [shadeHint, setShadeHint] = useState("");
  const [finishHint, setFinishHint] = useState<FinishName | "">("");
  const [collectionHint, setCollectionHint] = useState("");
  const [frameType, setFrameType] = useState<CaptureFrameType>("label");
  const [qualityHint, setQualityHint] = useState<string | null>(null);
  /** A short-lived message over the camera (repeat read, still checking), cleared after a moment. */
  const [cameraFlash, setCameraFlash] = useState<ViewfinderStatus | null>(null);
  useEffect(() => {
    if (!cameraFlash) return;
    const timer = setTimeout(() => setCameraFlash(null), CAMERA_FLASH_MS);
    return () => clearTimeout(timer);
  }, [cameraFlash]);
  const verdictRef = useRef<HTMLDivElement | null>(null);
  const scrollToVerdict = useCallback(() => {
    verdictRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);
  /** The latest Scan next handler, for a live read of a new bottle while a verdict shows. */
  const scanNextRef = useRef<() => void>(() => {});
  const handleCaptureRef = useRef<(event: CameraCaptureEvent) => void>(() => {});

  const [session, dispatch] = useReducer(sessionReducer, INITIAL_SESSION_STATE);
  const [frames, dispatchFrames] = useReducer(framesReducer, []);
  const phase = rapidAddPhase(session);
  const frameSummary = summarizeFrames(frames);
  const hasHints = Boolean(brandHint.trim() || shadeHint.trim());

  // Shelf mode: this session's verdicts across scans, in sessionStorage per user.
  const [shelf, dispatchShelf] = useReducer(shelfReducer, EMPTY_SHELF);
  const [shelfKey, setShelfKey] = useState<string | null>(null);
  const [shelfPendingKey, setShelfPendingKey] = useState<string | null>(null);
  const [shelfError, setShelfError] = useState<string | null>(null);
  const nearDupeReportedRef = useRef<NearDupeVerdict | null>(null);
  const shelfRef = useRef(shelf);
  useEffect(() => {
    shelfRef.current = shelf;
  });

  // Latest values for async callbacks that outlive a render.
  const sessionRef = useRef(session);
  const framesRef = useRef(frames);
  const hintsRef = useRef({ brand: brandHint, shadeName: shadeHint, finish: finishHint, collection: collectionHint });
  const bottleCaptureRef = useRef(flags.bottleCapture);
  const bottleSequenceRef = useRef(bottleSequence);
  const bottleRef = useRef(bottle);
  const stickyRef = useRef(sticky);
  const stickyUserRef = useRef<string | null>(null);
  const activeSurfaceRef = useRef<BottleSurface | null>(null);
  useEffect(() => {
    sessionRef.current = session;
    framesRef.current = frames;
    hintsRef.current = { brand: brandHint, shadeName: shadeHint, finish: finishHint, collection: collectionHint };
    bottleCaptureRef.current = flags.bottleCapture;
    bottleSequenceRef.current = bottleSequence;
  });

  const applyBottle = useCallback((action: BottleFlowAction) => {
    const next = bottleFlowReducer(bottleRef.current, action);
    bottleRef.current = next;
    setBottle(next);
    return next;
  }, []);

  /** Sticky hints in state and ref; `persist` also stores them for this user. */
  const setStickyHints = useCallback((next: StickyHints, persist: boolean) => {
    stickyRef.current = next;
    setSticky(next);
    if (persist) writeStickyHints(safeLocalStorage(), stickyUserRef.current, next);
  }, []);

  // One capture session per scanned item; concurrent frames share the same start request.
  const sessionPromiseRef = useRef<Promise<string> | null>(null);
  /** Bumped when a scan is abandoned, so a slow request of the old scan never lands on the next one. */
  const scanRef = useRef(0);
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

  useEffect(() => {
    let cancelled = false;
    void getCurrentUserId()
      .catch(() => null)
      .then((userId) => {
        if (cancelled) return;
        const user = userId === null ? null : String(userId);
        const key = shelfStorageKey(user);
        dispatchShelf({ type: "hydrated", entries: readShelf(safeShelfStorage(), key) });
        setShelfKey(key);
        stickyUserRef.current = user;
        setStickyHints(readStickyHints(safeLocalStorage(), user), false);
      });
    return () => {
      cancelled = true;
    };
  }, [setStickyHints]);
  useEffect(() => {
    if (shelfKey) writeShelf(safeShelfStorage(), shelfKey, shelf.entries);
  }, [shelf.entries, shelfKey]);

  const trackShelf = useCallback((action: ShelfTelemetryAction, entry?: ShelfEntry) => {
    const event = shelfActionEvent(action, shelfRef.current.entries.length, entry?.verdict);
    trackEvent(event.name, event.properties);
  }, []);

  /** Shades whose owned dupes the verdict card already looked up this page session. */
  const dupeCheckedRef = useRef(new Set<string>());

  /** Near-dupe check for a new catalog shade; failures leave it "New". */
  const checkShelfDupe = useCallback((entry: ShelfEntry) => {
    if (!entry.shadeId || !shelfNeedsDupeCheck(entry)) return;
    const shadeId = entry.shadeId;
    void getPolishDupeHints([shadeId]).then(
      (res) => {
        const dupe = shelfDupeFromHint(res.results[shadeId]);
        if (dupe) dispatchShelf({ type: "dupe_resolved", key: entry.key, dupe });
      },
      () => undefined,
    );
  }, []);

  // Every verdict lands on the shelf: the first of a scan adds (or re-flags) an entry, later
  // ones (Add / ♡ / undo on the card, a label photo after an unknown barcode) update it.
  useEffect(() => {
    if (!session.verdict || !shelfKey) return;
    const entry = shelfEntryFromVerdict(session.verdict, {
      captureId: session.captureId,
      now: Date.now(),
      quantityRestored: session.quantityRestored,
    });
    if (!entry) return;
    const current = shelfRef.current;
    const starts = shelfStartsEntry(current);
    const repeat = starts && current.entries.some((e) => e.key === entry.key);
    dispatchShelf({
      type: "verdict",
      entry,
      clearActed: session.verdict.kind === "owned" && session.quantityRestored,
    });
    if (repeat) trackShelf("repeat_scan", entry);
    else if (starts && !(entry.shadeId && dupeCheckedRef.current.has(entry.shadeId))) checkShelfDupe(entry);
  }, [session.verdict, session.quantityRestored, session.captureId, shelfKey, trackShelf, checkShelfDupe]);

  const ensureSession = useCallback(async (barcode: ScannedBarcode | null): Promise<string> => {
    if (sessionRef.current.captureId) return sessionRef.current.captureId;
    if (!sessionPromiseRef.current) {
      dispatch({ type: "busy", busy: "starting" });
      const scan = scanRef.current;
      sessionPromiseRef.current = startCapture({
        metadata: buildStartMetadata({
          barcode: barcode ?? sessionRef.current.barcode,
          hints: hintsRef.current,
          sticky: bottleCaptureRef.current ? stickyRef.current : null,
        }),
      }).then(
        (started) => {
          // The scan was abandoned (e.g. the batch brand changed) while this start was in flight.
          if (scanRef.current !== scan) return started.captureId;
          dispatch({ type: "session_started", captureId: started.captureId, status: started.status });
          sessionRef.current = { ...sessionRef.current, captureId: started.captureId, status: started.status };
          if (bottleSequenceRef.current) {
            applyBottle({ type: "session_started", brandHint: started.brandHint, nextFrame: started.nextFrame });
            // The server's spelling of the batch brand replaces what was typed.
            const batch = stickyRef.current;
            if (started.brandHint && isBatchMode(batch) && echoMatchesBatch(batch, started.brandHint)) {
              setStickyHints(withBrandEcho(batch, started.brandHint), true);
            }
          }
          return started.captureId;
        },
        (error: unknown) => {
          if (scanRef.current === scan) sessionPromiseRef.current = null;
          throw error;
        },
      );
    }
    return sessionPromiseRef.current;
  }, [applyBottle, setStickyHints]);

  /**
   * Show a verdict from a read-only check (nothing is added yet). A shade the user doesn't own
   * first gets its near-dupe lookup (one call, 2 s cap, never blocking), and the answer is
   * remembered so the shelf doesn't ask again.
   */
  const presentVerdict = useCallback(async (base: CaptureVerdict | null, barcode: ScannedBarcode | null) => {
    const scan = scanRef.current;
    let verdict = base;
    if (base) {
      const result = await resolveNearDupeVerdict(base, {
        suppressed: readSuppressedGuardKeys(safeSessionStorage()),
        loadDupes: (shadeId) => getPolishDupes(shadeId, { limit: NEAR_DUPE_CARD_MAX }),
      });
      if (scanRef.current !== scan) return;
      verdict = result.verdict;
      if (result.answered && base.kind === "checked" && base.shadeId) dupeCheckedRef.current.add(base.shadeId);
      if (result.failure) {
        trackEvent(ADD_GUARD_EVENTS.checkFailed, {
          page: "rapid-add",
          intent: "own",
          shade: base.kind === "checked" ? (base.shadeId ?? "new") : "new",
          reason: result.failure.reason,
        });
      }
      if (verdict?.kind === "near_dupe") {
        trackDupeWarningShown({
          surface: "rapid_add",
          response: verdict.dupes,
          details: nearDupeDetails(verdict),
        });
      }
    }
    dispatch({ type: "verdict_resolved", verdict });
    if (verdict) {
      trackEvent("rapid_add.verdict", {
        kind: verdict.kind,
        relationship: verdict.kind === "checked" ? verdict.relationship : null,
        barcodeEngine: barcode?.engine ?? null,
        frames: framesRef.current.length,
      });
    }
  }, []);

  /** Check the bottle sequence's photos (read-only) and show the verdict: match, pick, create card or not found. */
  const runBottleCheck = useCallback(async () => {
    const scan = scanRef.current;
    try {
      dispatch({ type: "busy", busy: "checking" });
      const captureId = await ensureSession(sessionRef.current.barcode);
      if (scanRef.current !== scan) return;
      dispatch({ type: "busy", busy: "checking" });
      const check = await checkCapture(captureId);
      if (scanRef.current !== scan) return;
      applyBottle({ type: "check_received", nextFrame: check.nextFrame, brandConflict: check.brandConflict });
      if (check.readSoFar) setReadSoFar(check.readSoFar);
      const barcode = sessionRef.current.barcode;
      await presentVerdict(
        verdictFromBottleCheck(check, { afterNoneOfThese: false, evidence: bottleEvidence(check, barcode?.gtin) }),
        barcode,
      );
    } catch (error) {
      if (scanRef.current !== scan) return;
      dispatch({
        type: "failed",
        error: `Couldn't check that bottle: ${errorMessage(error, "network error")}. Tap Find match.`,
      });
    }
  }, [ensureSession, applyBottle, presentVerdict]);

  const checkBarcode = useCallback(
    async (captureId: string, barcode: ScannedBarcode, check?: CaptureCheckResponse) => {
      try {
        dispatch({ type: "busy", busy: "checking" });
        await presentVerdict(verdictFromCheck(check ?? (await checkCapture(captureId)), barcode), barcode);
      } catch (error) {
        dispatch({
          type: "failed",
          error: `Couldn't check that barcode: ${errorMessage(error, "network error")}. Tap Find match.`,
        });
      }
    },
    [presentVerdict],
  );

  const uploadFrame = useCallback(
    async (frame: Pick<CaptureFrameEntry, "localId" | "frameType" | "dataUrl" | "quality">, barcode: ScannedBarcode | null) => {
      const scan = scanRef.current;
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
        if (res.readSoFar && scanRef.current === scan) setReadSoFar(res.readSoFar);
        if (checking && barcode) {
          await checkBarcode(captureId, barcode, res.check);
        } else if (bottleSequenceRef.current && scanRef.current === scan) {
          const next = applyBottle({
            type: "frame_uploaded",
            surface: surfaceFromQuality(frame.quality),
            nextFrame: res.nextFrame,
          });
          setManualSurface(null);
          const uploaded =
            framesRef.current.filter((f) => f.status === "uploaded" && f.localId !== frame.localId).length + 1;
          if (shouldAutoCheck(next, uploaded) && !sessionRef.current.verdict) await runBottleCheck();
        }
      } catch (error) {
        dispatchFrames({
          type: "upload_failed",
          localId: frame.localId,
          error: errorMessage(error, "Upload failed"),
        });
        dispatch({ type: "failed", error: `Couldn't upload a frame: ${errorMessage(error, "network error")}. Tap Retry on it.` });
      }
    },
    [ensureSession, checkBarcode, applyBottle, runBottleCheck],
  );

  const handleCapture = useCallback(
    (event: CameraCaptureEvent) => {
      if (event.trigger === "live-scan" && event.barcode) {
        const { gtin } = event.barcode;
        const action = planLiveBarcode(sessionRef.current, gtin);
        const hasVerdict = Boolean(sessionRef.current.verdict);
        switch (action) {
          case "repeat":
            // Photographing the label of an unknown barcode: the code is still in view, so stay quiet.
            if (sessionRef.current.labelRequested) return;
            setCameraFlash({
              tone: "info",
              text: hasVerdict ? `Already scanned ${gtin} — result above` : `Already scanned ${gtin}`,
              action: hasVerdict ? { label: "See result", onClick: scrollToVerdict } : undefined,
            });
            return;
          case "wait":
            setCameraFlash({ tone: "info", text: "Still checking the last scan…" });
            return;
          case "finish_first":
            setCameraFlash({
              tone: "warning",
              text: `Different barcode (${gtin})`,
              action: {
                label: "Scan it instead",
                onClick: () => {
                  scanNextRef.current();
                  handleCaptureRef.current(event);
                },
              },
            });
            return;
          case "next_scan":
            scanNextRef.current();
            break;
          case "scan":
            break;
        }
      }
      const current = sessionRef.current;
      if (rapidAddPhase(current) === "verdict" || rapidAddPhase(current) === "resolving") return;
      if (event.barcode) {
        dispatch({ type: "barcode_detected", barcode: event.barcode });
        sessionRef.current = { ...sessionRef.current, barcode: event.barcode };
      }
      if (!event.frame) {
        // Read live but no snapshot: check the barcode from the session metadata alone.
        const barcode = event.barcode;
        if (canCheckBarcodeFromMetadata(sessionRef.current, barcode)) {
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
          surface: event.barcode ? null : activeSurfaceRef.current,
        }),
      };
      framesRef.current = [...framesRef.current, { ...frame, status: "uploading", attempts: 1 }];
      dispatchFrames({ type: "added", frame });
      void uploadFrame(frame, event.barcode ?? sessionRef.current.barcode);
    },
    [uploadFrame, ensureSession, checkBarcode, scrollToVerdict],
  );
  useEffect(() => {
    handleCaptureRef.current = handleCapture;
  });

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

  /** The funnel outcome of a near-dupe verdict (`dupe.warning_outcome`, once per verdict). */
  function reportNearDupeOutcome(verdict: NearDupeVerdict, choice: NearDupeChoice, via: string) {
    if (nearDupeReportedRef.current === verdict) return;
    nearDupeReportedRef.current = verdict;
    trackDupeWarningOutcome({
      surface: "rapid_add",
      response: verdict.dupes,
      outcome: NEAR_DUPE_OUTCOMES[choice],
      details: { ...nearDupeDetails(verdict), via },
    });
  }

  function handleAddToCollection() {
    const verdict = session.verdict;
    if (verdict?.kind === "near_dupe") reportNearDupeOutcome(verdict, "add_anyway", "button");
    // The guided sequence adds a catalog shade straight to the inventory; a SKU without a shade
    // (and the legacy path) still goes through finalize.
    if (bottleSequence && (verdict?.kind === "checked" || verdict?.kind === "near_dupe") && verdict.shadeId) {
      void handleBottleAdd(verdict);
    } else {
      void handleFinalize();
    }
  }

  async function handleBottleAdd(verdict: CheckedVerdict | NearDupeVerdict) {
    if (!verdict.shadeId) return;
    const scan = scanRef.current;
    dispatch({ type: "busy", busy: "finalizing" });
    try {
      const updated = await updatePolish(verdict.shadeId, {
        status: "owned",
        quantity: bottleAddQuantity(verdict),
      });
      void loadSnapshot();
      if (scanRef.current !== scan) return;
      dispatch({ type: "verdict_resolved", verdict: verdictAfterBottleAdd(verdict, updated.inventoryItemId) });
    } catch (error) {
      if (scanRef.current !== scan) return;
      dispatch({ type: "failed", error: errorMessage(error, "Couldn't add it to your collection.") });
    }
  }

  async function handleCreate(verdict: CreateCardVerdict, edits: CreateCardEdits, status: "owned" | "wishlist") {
    const scan = scanRef.current;
    dispatch({ type: "busy", busy: "creating" });
    try {
      const created = await createPolish(createPolishRequestFromCard(verdict.card, edits, status));
      void loadSnapshot();
      if (scanRef.current !== scan) return;
      dispatch({ type: "verdict_resolved", verdict: verdictAfterCreate(created, verdict.card, edits, status) });
    } catch (error) {
      if (scanRef.current !== scan) return;
      dispatch({ type: "failed", error: errorMessage(error, "Couldn't add it. Try again.") });
    }
  }

  function handlePick(verdict: PickVerdict, candidate: CaptureCheckCandidate) {
    void presentVerdict(verdictFromPickedCandidate(verdict.check, candidate), session.barcode);
  }

  function handleNoneOfThese(verdict: PickVerdict) {
    const evidence = bottleEvidence(verdict.check, session.barcode?.gtin);
    void presentVerdict(
      verdictFromBottleCheck(verdict.check, { afterNoneOfThese: true, evidence }),
      session.barcode,
    );
  }

  function handleSwitchBrand(read: CaptureBrandRef) {
    setStickyHints(switchBrand(stickyRef.current, read), true);
  }

  /** The current scan is abandoned: a fresh session, photos and prompts for the next bottle. */
  function resetScan() {
    scanRef.current += 1;
    sessionPromiseRef.current = null;
    dispatch({ type: "reset" });
    dispatchFrames({ type: "reset" });
    sessionRef.current = INITIAL_SESSION_STATE;
    framesRef.current = [];
    applyBottle({ type: "reset" });
    setReadSoFar(null);
    setManualSurface(null);
    setQualityHint(null);
    setFrameType("label");
  }

  /**
   * A brand change applies to the next session. One already started without photos is dropped so
   * the prompts follow the new brand right away; with photos the change waits for the next bottle.
   */
  function restartUnusedSession() {
    const started = sessionRef.current.captureId !== null || sessionPromiseRef.current !== null;
    if (started && framesRef.current.length === 0 && !sessionRef.current.verdict) resetScan();
  }

  function handleConfirmBatchBrand(next: { brand: string; finish: string | null; collection: string | null }) {
    setStickyHints({ ...EMPTY_STICKY_HINTS, ...next }, true);
    restartUnusedSession();
    // Start the session now so the catalog spelling of the brand and the first prompt come back.
    if (bottleSequence && !sessionRef.current.captureId) {
      const scan = scanRef.current;
      void ensureSession(null).catch(() => {
        if (scanRef.current !== scan) return;
        dispatch({ type: "failed", error: "Couldn't reach the server yet. It will retry with your first photo." });
      });
    }
  }

  function handleBatchDone() {
    setStickyHints(EMPTY_STICKY_HINTS, true);
    restartUnusedSession();
  }

  async function handleSkipSurface() {
    const surface = activeView?.surface;
    if (!surface) return;
    const scan = scanRef.current;
    dispatch({ type: "busy", busy: "skipping" });
    try {
      const captureId = await ensureSession(session.barcode);
      if (scanRef.current !== scan) return;
      dispatch({ type: "busy", busy: "skipping" });
      const res = await answerCaptureQuestion(captureId, { skipSurface: surface });
      if (scanRef.current !== scan) return;
      trackEvent("rapid_add.bottle_skip", { surface });
      const next = applyBottle({ type: "surface_skipped", surface, nextFrame: res.nextFrame });
      if (res.readSoFar) setReadSoFar(res.readSoFar);
      setManualSurface(null);
      dispatch({ type: "status_received", status: res.status, question: res.question });
      const uploaded = framesRef.current.filter((f) => f.status === "uploaded").length;
      if (shouldAutoCheck(next, uploaded) && !sessionRef.current.verdict) await runBottleCheck();
    } catch (error) {
      if (scanRef.current !== scan) return;
      dispatch({ type: "failed", error: errorMessage(error, "Couldn't skip that photo. Try again.") });
    }
  }

  async function handleAddToWishlist(verdict: CaptureVerdict) {
    if ((verdict.kind !== "checked" && verdict.kind !== "near_dupe") || !verdict.shadeId) return;
    if (verdict.kind === "near_dupe") reportNearDupeOutcome(verdict, "wishlist", "button");
    const checked = verdict.kind === "near_dupe" ? checkedFromNearDupe(verdict) : verdict;
    const scan = scanRef.current;
    dispatch({ type: "busy", busy: "wishlisting" });
    try {
      await updatePolish(verdict.shadeId, { status: "wishlist" });
      if (scanRef.current !== scan) return;
      dispatch({ type: "verdict_resolved", verdict: { ...checked, relationship: "wishlisted", wishlistedNow: true } });
    } catch (error) {
      if (scanRef.current !== scan) return;
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
    const scan = scanRef.current;
    dispatch({ type: "busy", busy: "undoing" });
    try {
      await updatePolish(verdict.shadeId, { quantity: verdict.previousQuantity });
      if (scanRef.current !== scan) return;
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
      if (scanRef.current !== scan) return;
      dispatch({ type: "failed", error: errorMessage(error, "Couldn't update the quantity.") });
    }
  }

  async function handleShelfAction(entry: ShelfEntry, action: Exclude<ShelfQuickAction, "manual">) {
    setShelfPendingKey(entry.key);
    setShelfError(null);
    trackShelf(action, entry);
    try {
      if (action === "wishlist" && entry.shadeId) {
        await updatePolish(entry.shadeId, { status: "wishlist" });
        dispatchShelf({ type: "acted", key: entry.key, acted: "wishlisted" });
      } else if (action === "bought_another" && entry.shadeId) {
        const quantity = (entry.quantity ?? 1) + 1;
        const updated = await updatePolish(entry.shadeId, { status: "owned", quantity });
        dispatchShelf({ type: "acted", key: entry.key, acted: "bought_another", quantity: updated.quantity ?? quantity });
      } else if (action === "add" && entry.shadeId) {
        const updated = await updatePolish(entry.shadeId, { status: "owned", quantity: 1 });
        dispatchShelf({ type: "acted", key: entry.key, acted: "added", quantity: updated.quantity ?? 1 });
      } else if (action === "add" && entry.captureId) {
        // A barcode SKU without a shade: only its capture session can add it.
        const res = await finalizeCapture(entry.captureId);
        if (res.status !== "matched") throw new Error("That scan needs another look. Scan it again.");
        dispatchShelf({ type: "acted", key: entry.key, acted: "added" });
      }
      // Keep the ownership snapshot right for the next label scan.
      void loadSnapshot();
    } catch (error) {
      setShelfError(errorMessage(error, "Couldn't save that. Try again."));
    } finally {
      setShelfPendingKey(null);
    }
  }

  function handleClearShelf() {
    trackShelf("clear");
    dispatchShelf({ type: "cleared" });
    setShelfError(null);
  }

  function handleScanNext() {
    // Cancel on a near-dupe verdict: nothing is added.
    const verdict = sessionRef.current.verdict;
    if (verdict?.kind === "near_dupe") reportNearDupeOutcome(verdict, "cancel", "scan_next");
    dispatchShelf({ type: "scan_ended" });
    resetScan();
  }
  useEffect(() => {
    scanNextRef.current = handleScanNext;
  });

  const finalizeEnabled = (bottleSequence ? canCheck : canFinalize)({ frames, session, hasHints });
  const badge = phase === "verdict" ? null : scanBadge(session);
  // Keeps scanning after a read, so a repeat read or the next bottle gets an answer (`planLiveBarcode`).
  const scanning = phase !== "resolving";
  const busy = session.busy !== null;
  const hintsLocked = session.captureId !== null;

  const bottleView = bottleSequence ? deriveBottleCameraView(bottle, { brandKnown: Boolean(sticky.brandId) }) : null;
  const activeView = manualSurface && bottleSequence ? viewForSurface(manualSurface, bottleView) : bottleView;
  useEffect(() => {
    activeSurfaceRef.current = activeView?.surface ?? null;
  });
  const matching =
    session.busy === "finalizing" ||
    session.busy === "resolving" ||
    (bottleSequence && session.busy === "checking");
  const showAddFrames = bottleSequence && session.verdict?.kind === "add";
  // One auto-shot per prompt: the key changes with every frame taken, so the next prompt re-arms it.
  const autoCaptureKey =
    phase !== "collecting" || busy
      ? null
      : bottleSequence
        ? activeView
          ? `${frames.length}:${activeView.surface}`
          : null
        : session.labelRequested
          ? `${frames.length}:label`
          : null;
  // The outline follows what is asked for: the bottle prompt's surface, the label after an unknown
  // barcode, else the frame type chip. Barcodes are read anywhere in the frame whatever it shows.
  const cameraGuide: CameraGuide =
    bottleSequence && activeView
      ? activeView.surface
      : session.labelRequested
        ? "label"
        : defaultCameraGuide(frameType);
  const viewfinderStatus: ViewfinderStatus | null =
    cameraFlash ??
    (session.verdict
      ? { tone: "success", text: verdictHeadline(session.verdict), action: { label: "See result", onClick: scrollToVerdict } }
      : badge
        ? { tone: "success", text: badge.checking ? `Scanned ${badge.gtin} — checking…` : `Scanned ${badge.gtin}` }
        : session.error
          ? { tone: "warning", text: session.error }
          : null);

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
        <div ref={verdictRef} className="scroll-mt-4">
        <VerdictCard
          verdict={session.verdict}
          quantityRestored={session.quantityRestored}
          undoing={session.busy === "undoing"}
          busy={session.busy}
          onUndoQuantity={() => void handleUndoQuantity()}
          onAddToCollection={handleAddToCollection}
          onNearDupeLink={(verdict) => reportNearDupeOutcome(verdict, "cancel", "dupe_link")}
          onAddToWishlist={(verdict) => void handleAddToWishlist(verdict)}
          onPhotographLabel={handlePhotographLabel}
          onPick={handlePick}
          onNoneOfThese={handleNoneOfThese}
          onCreate={(verdict, edits, status) => void handleCreate(verdict, edits, status)}
          onSwitchBrand={handleSwitchBrand}
          frameStrip={
            showAddFrames ? (
              <FrameStrip
                frames={frames}
                onRetry={handleRetryFrame}
                onRemove={(localId) => dispatchFrames({ type: "removed", localId })}
              />
            ) : undefined
          }
          onScanNext={handleScanNext}
        />
        </div>
      )}

      <Card ref={cameraSectionRef} className="scroll-mt-4">
        <CardContent className="space-y-4">
          {flags.bottleCapture && (
            <BatchBrandField
              hints={sticky}
              finishOptions={finishOptions}
              onConfirm={handleConfirmBatchBrand}
              onDone={handleBatchDone}
            />
          )}

          {bottleSequence && phase === "collecting" && (
            <BottlePromptPanel
              view={activeView}
              captured={bottle.captured}
              skipped={bottle.skipped}
              disabled={busy || frameSummary.uploading > 0}
              onSelectSurface={(surface) => setManualSurface(surface)}
              onSkip={() => void handleSkipSurface()}
            />
          )}

          <CameraCapture
            scanBarcodes={scanning}
            captureDisabled={
              phase === "verdict" ||
              phase === "resolving" ||
              !canAddFrame(frames) ||
              (bottleSequence && (!activeView || busy || frameSummary.uploading > 0))
            }
            frameType={activeView?.frameType ?? frameType}
            onFrameTypeChange={setFrameType}
            hideFrameTypeOptions={bottleSequence}
            onCapture={handleCapture}
            autoCaptureKey={autoCaptureKey}
            guide={cameraGuide}
            status={viewfinderStatus}
            onCameraError={(kind) => trackEvent("rapid_add.camera_error", { kind })}
          />

          {bottleSequence && phase === "collecting" && (
            <BottleReadPanel summary={readSoFar} liveBarcode={session.barcode?.gtin ?? null} />
          )}

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

          {!showAddFrames && (
            <FrameStrip
              frames={frames}
              onRetry={handleRetryFrame}
              onRemove={(localId) => dispatchFrames({ type: "removed", localId })}
            />
          )}

          {flags.bottleCapture && phase === "collecting" && (
            <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={() => setMoreOptions((on) => !on)}>
              {moreOptions ? "Back to guided photos" : "More options"}
            </Button>
          )}
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
            onClick={() => (bottleSequence ? void runBottleCheck() : void handleFinalize())}
            disabled={!finalizeEnabled}
          >
            {matching ? <Loader2 className="animate-spin" aria-hidden /> : <Search aria-hidden />}
            {matching ? "Matching…" : "Find match"}
          </Button>
          <p className="text-center text-xs text-muted-foreground">
            {frameSummary.uploading > 0
              ? "Uploading frames…"
              : bottleSequence
                ? "Nothing is added until you tap Add."
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

      <ShelfList
        entries={shelf.entries}
        repeatKey={shelf.repeatKey}
        pendingKey={shelfPendingKey}
        currentKey={session.verdict ? shelf.currentKey : null}
        onAction={(entry, action) => void handleShelfAction(entry, action)}
        onManualAdd={(entry) => trackShelf("manual", entry)}
        onClear={handleClearShelf}
      />
      {shelfError && (
        <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">{shelfError}</span>
        </p>
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
