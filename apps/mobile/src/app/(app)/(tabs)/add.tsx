import { CameraView, useCameraPermissions, type BarcodeScanningResult } from "expo-camera";
import * as Haptics from "expo-haptics";
import * as ImagePicker from "expo-image-picker";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Linking, Platform, Pressable, ScrollView, TextInput, View } from "react-native";
import {
  bottleFlowReducer,
  createPolishRequestFromCard,
  deriveBottleCameraView,
  EMPTY_STICKY_HINTS,
  INITIAL_BOTTLE_FLOW_STATE,
  isBatchMode,
  shouldAutoCheck,
  surfaceFromQuality,
  switchBrand,
  withBrandEcho,
  type BottleSurface,
  type CaptureCheckCandidate,
  type CaptureCheckResponse,
  type CaptureFrameType,
  type CreateCardEdits,
  type CreateCardModel,
  type StickyHints,
} from "swatchwatch-shared";
import {
  addCaptureFrame,
  answerCaptureQuestion,
  ApiError,
  checkCapture,
  createPolish,
  errorMessage,
  finalizeCapture,
  startCapture,
  updatePolish,
} from "@/api/client";
import { useAuth } from "@/auth/auth-provider";
import { BatchBrandBar, BottlePrompt } from "@/components/bottle-prompt";
import { FrameStrip } from "@/components/frame-strip";
import { AppText, Button, Card, Chip, ErrorBanner } from "@/components/ui";
import { ShelfList } from "@/components/shelf-list";
import { VerdictCard, type VerdictBusy } from "@/components/verdict-card";
import { fetchOwnedDupes } from "@/lib/add-guard";
import { readCache, writeCache } from "@/lib/api-cache";
import { notifyCollectionChanged } from "@/lib/collection-events";
import { useFeatureFlags } from "@/lib/feature-flags";
import { prepareJpeg } from "@/lib/image-prep";
import {
  buildFrameQuality,
  buildStartMetadata,
  canCheck,
  createdCandidate,
  deriveBottleVerdict,
  deriveVerdict,
  framesReducer,
  isRetryableStatus,
  MAX_CAPTURE_FRAMES,
  NATIVE_BARCODE_TYPES,
  normalizeNativeBarcode,
  summarizeFrames,
  UPLOAD_RETRY_DELAYS_MS,
  verdictForCandidate,
  withDupes,
  type CaptureFrameEntry,
  type RapidAddVerdict,
  type ScannedBarcode,
} from "@/lib/rapid-add";
import { manualAddRoute } from "@/lib/manual-add";
import { readStickyHintsCache, writeStickyHintsCache } from "@/lib/sticky-hints";
import {
  EMPTY_SHELF,
  parseShelfEntries,
  SHELF_CACHE_KEY,
  shelfEntryFromVerdict,
  shelfReducer,
  shelfToStored,
  type ShelfActed,
  type ShelfEntry,
  type ShelfQuickAction,
} from "@/lib/shelf";
import { useTheme } from "@/theme/theme";

const FRAME_TYPES: { type: CaptureFrameType; label: string }[] = [
  { type: "barcode", label: "Barcode" },
  { type: "label", label: "Label" },
  { type: "color", label: "Color" },
];

type Busy = "checking" | "capturing" | null;

function newLocalId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Upgrade a "new to you" verdict to near-dupe when the shopper owns a close shade. */
async function enrich(verdict: RapidAddVerdict): Promise<RapidAddVerdict> {
  if (verdict.kind !== "add" || !verdict.candidate.shadeId) return verdict;
  return withDupes(verdict, await fetchOwnedDupes(verdict.candidate.shadeId));
}

/**
 * Rapid Add (web: `/rapid-add`), native: the rear camera scans retail barcodes on device;
 * frames (tagged barcode / label / color) go to `POST /api/capture/{id}/frame` with retry;
 * `POST /api/capture/{id}/check` answers "own it / on wishlist / near-dupe / new" read-only,
 * and only an explicit tap adds the polish.
 */
export default function RapidAddScreen() {
  const theme = useTheme();
  const { user } = useAuth();
  const scope = user ? String(user.userId) : null;
  const bottle = useFeatureFlags().bottleCapture;
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);
  const [focused, setFocused] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [frameType, setFrameType] = useState<CaptureFrameType>("barcode");
  const [frames, dispatchFrames] = useReducer(framesReducer, []);
  const [barcode, setBarcode] = useState<ScannedBarcode | null>(null);
  const [verdict, setVerdict] = useState<RapidAddVerdict | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [verdictBusy, setVerdictBusy] = useState<VerdictBusy>(null);
  const [error, setError] = useState<string | null>(null);
  const [showHints, setShowHints] = useState(false);
  const [brandHint, setBrandHint] = useState("");
  const [shadeHint, setShadeHint] = useState("");
  const [sessionStarted, setSessionStarted] = useState(false);
  const [shelf, dispatchShelf] = useReducer(shelfReducer, EMPTY_SHELF);
  /** User whose saved shelf has been loaded; nothing is written back before that. */
  const [shelfLoadedFor, setShelfLoadedFor] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [shelfBusyKey, setShelfBusyKey] = useState<string | null>(null);
  /** Shelf entry the scan in progress made, so its later Add / ♡ taps update that entry. */
  const shelfKeyRef = useRef<string | null>(null);

  // Values async callbacks need without re-creating them each render.
  const sessionPromise = useRef<Promise<string> | null>(null);
  const captureIdRef = useRef<string | null>(null);
  const barcodeLock = useRef(false);
  /** Bumped by "Scan next": async work from an earlier scan must not touch the new one. */
  const scanGeneration = useRef(0);
  /** Frames queued for this scan, counted when a photo starts so quick taps can't pass the cap. */
  const frameCount = useRef(0);
  const hintsRef = useRef({ brand: "", shadeName: "" });

  // Bottle sequence (BOTTLE_CAPTURE_ENABLED): prompts from the server, a remembered brand for
  // "going through one brand", and the create card. All unused while the flag is off.
  const [flow, dispatchFlow] = useReducer(bottleFlowReducer, INITIAL_BOTTLE_FLOW_STATE);
  const [sticky, setSticky] = useState<StickyHints>(EMPTY_STICKY_HINTS);
  const stickyRef = useRef<StickyHints>(EMPTY_STICKY_HINTS);
  /** A photo type picked under "More options", used for the next photo only. */
  const [manualType, setManualType] = useState<CaptureFrameType | null>(null);
  /** The scan's latest check response, so "None of these" can show the create card without a request. */
  const lastCheckRef = useRef<CaptureCheckResponse | null>(null);
  /** Set when a check has started since the last photo, so the auto-check runs once per photo. */
  const checkedRef = useRef(false);

  const updateSticky = useCallback(
    (next: StickyHints) => {
      stickyRef.current = next;
      setSticky(next);
      if (scope) void writeStickyHintsCache(scope, next).catch(() => undefined);
    },
    [scope],
  );

  // The remembered brand comes back per user on launch (sign-out wipes it with the API cache).
  useEffect(() => {
    if (!scope || !bottle) return;
    let cancelled = false;
    void readStickyHintsCache(scope).then((hints) => {
      if (cancelled) return;
      stickyRef.current = hints;
      setSticky(hints);
    });
    return () => {
      cancelled = true;
    };
  }, [scope, bottle]);

  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );

  // The shelf is restored per user on launch and saved after every change (ids, names, hexes,
  // verdicts, GTINs and times only); sign-out wipes it with the rest of the API cache.
  useEffect(() => {
    if (!scope) return;
    let cancelled = false;
    void readCache<unknown>(scope, SHELF_CACHE_KEY).then((entry) => {
      if (cancelled) return;
      dispatchShelf({ type: "hydrated", entries: entry ? parseShelfEntries(entry.data) : [] });
      setShelfLoadedFor(scope);
    });
    return () => {
      cancelled = true;
    };
  }, [scope]);

  // Ages on the shelf ("2 min ago") refresh while the tab is open.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (scope && shelfLoadedFor === scope) void writeCache(scope, SHELF_CACHE_KEY, shelfToStored(shelf.entries));
  }, [scope, shelfLoadedFor, shelf.entries]);

  /** Record a final verdict on the shelf (a pick waits for the choice). */
  const recordVerdict = useCallback((verdict: RapidAddVerdict, gtin: string | undefined) => {
    const entry = shelfEntryFromVerdict(verdict, { gtin, captureId: captureIdRef.current, now: Date.now() });
    if (!entry) return;
    shelfKeyRef.current = entry.key;
    dispatchShelf({ type: "verdict", entry });
  }, []);

  const ensureSession = useCallback(
    (scanned: ScannedBarcode | null): Promise<string> => {
      if (!sessionPromise.current) {
        // Only the current scan's promise may write the refs: "Scan next" can replace it while
        // an older start request is still in flight.
        const promise: Promise<string> = startCapture({
          metadata: buildStartMetadata({
            barcode: scanned,
            hints: hintsRef.current,
            sticky: bottle ? stickyRef.current : null,
          }),
        }).then(
          (started) => {
            if (sessionPromise.current === promise) {
              captureIdRef.current = started.captureId;
              setSessionStarted(true);
              if (bottle) {
                dispatchFlow({ type: "session_started", brandHint: started.brandHint, nextFrame: started.nextFrame });
                // Remember the catalog brand the server matched for the remembered text (not a one-off typed hint).
                if (!hintsRef.current.brand.trim()) {
                  const echoed = withBrandEcho(stickyRef.current, started.brandHint);
                  if (echoed !== stickyRef.current) updateSticky(echoed);
                }
              }
            }
            return started.captureId;
          },
          (err: unknown) => {
            if (sessionPromise.current === promise) sessionPromise.current = null;
            throw err;
          },
        );
        sessionPromise.current = promise;
      }
      return sessionPromise.current;
    },
    [bottle, updateSticky],
  );

  /** Upload one frame; transient failures retry automatically, then it waits for a manual Retry. */
  const uploadFrame = useCallback(
    async (frame: Pick<CaptureFrameEntry, "localId" | "frameType" | "dataUrl" | "quality">, scanned: ScannedBarcode | null) => {
      const generation = scanGeneration.current;
      for (let attempt = 0; ; attempt += 1) {
        if (generation !== scanGeneration.current) return;
        try {
          const captureId = await ensureSession(scanned);
          if (generation !== scanGeneration.current) return;
          const res = await addCaptureFrame(captureId, {
            frameType: frame.frameType,
            imageBlobUrl: frame.dataUrl,
            quality: frame.quality,
          });
          dispatchFrames({ type: "upload_succeeded", localId: frame.localId, frameId: res.frameId });
          if (bottle && generation === scanGeneration.current) {
            checkedRef.current = false;
            dispatchFlow({ type: "frame_uploaded", surface: surfaceFromQuality(frame.quality), nextFrame: res.nextFrame });
          }
          return;
        } catch (err) {
          const status = err instanceof ApiError ? err.status : 0;
          const delay = UPLOAD_RETRY_DELAYS_MS[attempt];
          if (generation !== scanGeneration.current) return;
          if (delay !== undefined && isRetryableStatus(status)) {
            await wait(delay);
            continue;
          }
          const message = errorMessage(err, "Upload failed");
          dispatchFrames({ type: "upload_failed", localId: frame.localId, error: message });
          setError(`Couldn't upload a photo: ${message} Tap Retry on it.`);
          return;
        }
      }
    },
    [ensureSession, bottle],
  );

  const addFrame = useCallback(
    async (input: {
      uri: string;
      width: number;
      height: number;
      type: CaptureFrameType;
      source: "mobile-camera" | "mobile-library";
      scanned: ScannedBarcode | null;
      surface?: BottleSurface | null;
    }) => {
      if (frameCount.current >= MAX_CAPTURE_FRAMES) {
        setError(`That's the most photos for one scan (${MAX_CAPTURE_FRAMES}). Tap Check, or remove a failed one.`);
        return { upload: Promise.resolve() };
      }
      frameCount.current += 1;
      let prepared: Awaited<ReturnType<typeof prepareJpeg>>;
      try {
        prepared = await prepareJpeg(input.uri, input, { maxEdge: 1600, compress: 0.7 });
      } catch (err) {
        frameCount.current -= 1;
        throw err;
      }
      const frame = {
        localId: newLocalId(),
        frameType: input.type,
        dataUrl: prepared.dataUrl,
        quality: buildFrameQuality({
          source: input.source,
          width: prepared.width,
          height: prepared.height,
          sourceWidth: input.width,
          sourceHeight: input.height,
          barcode: input.scanned,
          surface: input.surface,
        }),
      };
      dispatchFrames({ type: "added", frame });
      // Wrapped so callers can await the photo being queued without waiting for the upload.
      return { upload: uploadFrame(frame, input.scanned) };
    },
    [uploadFrame],
  );

  const runCheck = useCallback(
    async (scanned: ScannedBarcode | null) => {
      const generation = scanGeneration.current;
      checkedRef.current = true;
      setBusy("checking");
      setError(null);
      try {
        const captureId = await ensureSession(scanned);
        const res = await checkCapture(captureId);
        const next = await enrich(
          bottle ? deriveBottleVerdict(res, { afterNoneOfThese: false, gtin: scanned?.gtin }) : deriveVerdict(res, scanned?.gtin),
        );
        if (generation !== scanGeneration.current) return;
        lastCheckRef.current = res;
        if (bottle) dispatchFlow({ type: "check_received", nextFrame: res.nextFrame, brandConflict: res.brandConflict });
        setVerdict(next);
        recordVerdict(next, scanned?.gtin);
        void Haptics.notificationAsync(
          next.kind === "owned" || next.kind === "near-dupe"
            ? Haptics.NotificationFeedbackType.Warning
            : Haptics.NotificationFeedbackType.Success,
        ).catch(() => undefined);
      } catch (err) {
        if (generation === scanGeneration.current) setError(errorMessage(err, "Matching failed. Try again."));
      } finally {
        if (generation === scanGeneration.current) setBusy(null);
      }
    },
    [ensureSession, recordVerdict, bottle],
  );

  const takeFrame = useCallback(
    /** Resolves once the photo is taken and its upload has finished (or failed). */
    async (type: CaptureFrameType, scanned: ScannedBarcode | null, surface: BottleSurface | null = null): Promise<void> => {
      const camera = cameraRef.current;
      if (!camera) return;
      setBusy((b) => b ?? "capturing");
      let upload: Promise<void> = Promise.resolve();
      try {
        const picture = await camera.takePictureAsync({ quality: 0.8, shutterSound: false });
        ({ upload } = await addFrame({ uri: picture.uri, width: picture.width, height: picture.height, type, source: "mobile-camera", scanned, surface }));
      } catch (err) {
        setError(errorMessage(err, "Couldn't take the photo."));
      } finally {
        setBusy((b) => (b === "capturing" ? null : b));
      }
      await upload;
    },
    [addFrame],
  );

  const handleBarcode = useCallback(
    (result: BarcodeScanningResult) => {
      if (barcodeLock.current) return;
      const scanned = normalizeNativeBarcode(result);
      if (!scanned) return;
      barcodeLock.current = true;
      setBarcode(scanned);
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
      if (sessionPromise.current) {
        // A session already exists (started by an earlier photo) without this GTIN: it only
        // reaches the resolver through the barcode frame's quality, so check after that upload.
        void takeFrame("barcode", scanned).then(() => runCheck(scanned));
      } else {
        // A new session carries the GTIN in its start metadata, so check right away; the
        // photo is uploaded alongside as evidence for the resolver.
        void takeFrame("barcode", scanned);
        void runCheck(scanned);
      }
    },
    [runCheck, takeFrame],
  );

  /** The photo the shutter and "Choose a photo" take next: the prompt's, a "More options" pick, or the chip's. */
  function nextShot(): { type: CaptureFrameType; surface: BottleSurface | null } {
    if (!bottle) return { type: frameType, surface: null };
    if (manualType) return { type: manualType, surface: null };
    return view ? { type: view.frameType, surface: view.surface } : { type: "label", surface: null };
  }

  /** "Can't see it": skip the asked-for surface (a request once the scan has a session, else local). */
  async function skipSurface() {
    if (!view) return;
    const generation = scanGeneration.current;
    const surface = view.surface;
    setError(null);
    checkedRef.current = false;
    try {
      const captureId = flow.sessionStarted ? captureIdRef.current : null;
      const res = captureId ? await answerCaptureQuestion(captureId, { skipSurface: surface }) : null;
      if (generation === scanGeneration.current) dispatchFlow({ type: "surface_skipped", surface, nextFrame: res?.nextFrame });
    } catch (err) {
      if (generation === scanGeneration.current) setError(errorMessage(err, "Couldn't skip that photo. Try again."));
    }
  }

  /** The create card's Add / Wishlist: the only place a bottle becomes a new catalog polish. */
  async function createFromCard(card: CreateCardModel, edits: CreateCardEdits, status: "owned" | "wishlist") {
    const generation = scanGeneration.current;
    const current = () => generation === scanGeneration.current;
    setVerdictBusy(status);
    setError(null);
    try {
      const created = await createPolish(createPolishRequestFromCard(card, edits, status));
      if (!current()) return;
      notifyCollectionChanged();
      const quantity = status === "owned" ? (created.quantity ?? 1) : undefined;
      setVerdict({ kind: "added", candidate: createdCandidate(created, status, edits.hex), status, quantity });
      markActed(status === "owned" ? "added" : "wishlisted", quantity);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
    } catch (err) {
      if (current()) setError(errorMessage(err, "Couldn't add it. Try again."));
    } finally {
      if (current()) setVerdictBusy(null);
    }
  }

  /** "None of these": in the bottle flow the last check's suggestion becomes the create card. */
  function noneOfThese() {
    const last = lastCheckRef.current;
    const next: RapidAddVerdict =
      bottle && last ? deriveBottleVerdict(last, { afterNoneOfThese: true, gtin: barcode?.gtin }) : { kind: "not-found", gtin: barcode?.gtin };
    setVerdict(next);
    recordVerdict(next, barcode?.gtin);
  }

  async function pickFromLibrary() {
    setError(null);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 1 });
      const asset = result.canceled ? null : result.assets[0];
      if (!asset) return;
      const shot = nextShot();
      await addFrame({
        uri: asset.uri,
        width: asset.width,
        height: asset.height,
        type: shot.type === "barcode" ? "label" : shot.type,
        source: "mobile-library",
        scanned: barcode,
        surface: shot.surface,
      });
      setManualType(null);
    } catch (err) {
      setError(errorMessage(err, "Couldn't use that photo."));
    }
  }

  /** Only a failed frame can be removed (the reducer keeps uploaded ones); it frees its slot. */
  function removeFrame(localId: string) {
    if (frames.some((f) => f.localId === localId && f.status === "failed")) {
      frameCount.current = Math.max(0, frameCount.current - 1);
    }
    dispatchFrames({ type: "removed", localId });
  }

  function retryFrame(localId: string) {
    const frame = frames.find((f) => f.localId === localId);
    if (!frame) return;
    dispatchFrames({ type: "upload_started", localId });
    setError(null);
    void uploadFrame(frame, barcode);
  }

  function markActed(acted: ShelfActed, quantity?: number) {
    if (shelfKeyRef.current) dispatchShelf({ type: "acted", key: shelfKeyRef.current, acted, quantity });
  }

  /** A shelf entry's quick action: the same calls as the verdict card, nothing without a tap. */
  async function shelfAction(entry: ShelfEntry, action: ShelfQuickAction) {
    if (!entry.shadeId) return;
    setShelfBusyKey(entry.key);
    setError(null);
    try {
      if (action === "bought_another") {
        const target = (entry.quantity ?? 1) + 1;
        const updated = await updatePolish(entry.shadeId, { status: "owned", quantity: target });
        dispatchShelf({ type: "acted", key: entry.key, acted: "bought_another", quantity: updated.quantity ?? target });
      } else if (action === "add") {
        const updated = await updatePolish(entry.shadeId, { status: "owned", quantity: 1 });
        dispatchShelf({ type: "acted", key: entry.key, acted: "added", quantity: updated.quantity ?? 1 });
      } else {
        await updatePolish(entry.shadeId, { status: "wishlist" });
        dispatchShelf({ type: "acted", key: entry.key, acted: "wishlisted" });
      }
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
    } catch (err) {
      setError(errorMessage(err, "Couldn't update that polish. Try again."));
    } finally {
      setShelfBusyKey(null);
    }
  }

  // The handlers below capture the scan they started in: if the shopper taps "Scan next" before
  // the response arrives, the late result must not appear on the next scan.
  async function addCandidate(candidate: CaptureCheckCandidate, status: "owned" | "wishlist") {
    const generation = scanGeneration.current;
    const current = () => generation === scanGeneration.current;
    setVerdictBusy(status);
    setError(null);
    try {
      if (candidate.shadeId) {
        const updated = await updatePolish(candidate.shadeId, status === "owned" ? { status, quantity: 1 } : { status });
        if (!current()) return;
        setVerdict({ kind: "added", candidate, status, quantity: updated.quantity });
        markActed(status === "owned" ? "added" : "wishlisted", updated.quantity);
      } else if (status === "owned" && captureIdRef.current) {
        // A barcode (SKU) match without a catalog shade (only reached for the resolver's own
        // match, never a picked candidate): finalize adds what the resolver matched. Report
        // success only when it confirms a match.
        const finalized = await finalizeCapture(captureIdRef.current);
        if (!current()) return;
        if (finalized.status !== "matched") {
          setError("Couldn't add that one automatically. Try searching for it by name.");
          return;
        }
        setVerdict({ kind: "added", candidate, status });
        markActed("added");
      } else {
        return;
      }
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
    } catch (err) {
      if (current()) setError(errorMessage(err, "Couldn't add it. Try again."));
    } finally {
      if (current()) setVerdictBusy(null);
    }
  }

  async function addBottle(candidate: CaptureCheckCandidate, quantity: number) {
    if (!candidate.shadeId) return;
    const generation = scanGeneration.current;
    const current = () => generation === scanGeneration.current;
    setVerdictBusy("bottle");
    try {
      const updated = await updatePolish(candidate.shadeId, { status: "owned", quantity });
      if (current()) {
        setVerdict({ kind: "added", candidate, status: "owned", quantity: updated.quantity ?? quantity });
        markActed("bought_another", updated.quantity ?? quantity);
      }
    } catch (err) {
      if (current()) setError(errorMessage(err, "Couldn't update the bottle count."));
    } finally {
      if (current()) setVerdictBusy(null);
    }
  }

  async function pickCandidate(candidate: CaptureCheckCandidate) {
    const generation = scanGeneration.current;
    const next = await enrich(verdictForCandidate(candidate));
    if (generation === scanGeneration.current) {
      setVerdict(next);
      recordVerdict(next, barcode?.gtin);
    }
  }

  function scanLabel() {
    setVerdict(null);
    setFrameType("label");
    if (bottle) setManualType("label");
  }

  function scanNext() {
    scanGeneration.current += 1;
    shelfKeyRef.current = null;
    dispatchShelf({ type: "scan_ended" });
    frameCount.current = 0;
    setVerdictBusy(null);
    sessionPromise.current = null;
    captureIdRef.current = null;
    barcodeLock.current = false;
    hintsRef.current = { brand: "", shadeName: "" };
    dispatchFlow({ type: "reset" });
    lastCheckRef.current = null;
    checkedRef.current = false;
    setManualType(null);
    setSessionStarted(false);
    setBrandHint("");
    setShadeHint("");
    setVerdict(null);
    setBarcode(null);
    setError(null);
    setFrameType("barcode");
    dispatchFrames({ type: "reset" });
  }

  const summary = summarizeFrames(frames);
  const view = bottle ? deriveBottleCameraView(flow, { brandKnown: isBatchMode(sticky) }) : null;
  const shotType = bottle ? nextShot().type : frameType;
  const hasHints = Boolean(brandHint.trim() || shadeHint.trim());
  const checkEnabled = canCheck({ frames, hasBarcode: Boolean(barcode), hasHints, busy: busy === "checking" });
  const cameraAllowed = permission?.granted === true;
  const showCamera = focused && cameraAllowed && !verdict && Platform.OS !== "web";

  // Once the server asks for nothing more and a photo is in, the check runs without a tap.
  const autoCheckReady = bottle && !verdict && busy === null && summary.uploading === 0 && shouldAutoCheck(flow, summary.uploaded);
  useEffect(() => {
    if (autoCheckReady && !checkedRef.current) void runCheck(barcode);
  }, [autoCheckReady, runCheck, barcode]);

  return (
    <ScrollView contentContainerStyle={{ padding: theme.spacing(4), gap: theme.spacing(4) }} keyboardShouldPersistTaps="handled">
      {verdict ? (
        <VerdictCard
          verdict={verdict}
          busy={verdictBusy}
          onAdd={(c, s) => void addCandidate(c, s)}
          onAddBottle={(c, q) => void addBottle(c, q)}
          onPick={(c) => void pickCandidate(c)}
          onNoneOfThese={noneOfThese}
          onScanLabel={scanLabel}
          onAddManually={() => {
            // What the scan read off the bottle rides along when the shopper typed nothing.
            const suggested = lastCheckRef.current?.suggestedShade;
            router.push(
              manualAddRoute({
                gtin: barcode?.gtin ?? suggested?.gtin ?? undefined,
                format: barcode?.format,
                brand: brandHint || suggested?.brandName || undefined,
                name: shadeHint || suggested?.shadeName || undefined,
              }),
            );
          }}
          onScanNext={scanNext}
          onCreate={(card, edits, status) => void createFromCard(card, edits, status)}
          onSwitchBrand={(read) => updateSticky(switchBrand(stickyRef.current, read))}
          frames={frames}
        />
      ) : (
        <>
          <AppText muted>Scan a bottle to see if you already own it, then add it in one tap.</AppText>

          {bottle && (
            <>
              <BatchBrandBar
                hints={sticky}
                onSetBrand={(brand) => updateSticky({ ...stickyRef.current, brand, brandCanonical: null, brandId: null })}
                onDone={() => updateSticky(EMPTY_STICKY_HINTS)}
              />
              <BottlePrompt
                view={view}
                manualType={manualType}
                disabled={busy !== null}
                onManualType={setManualType}
                onSkip={() => void skipSurface()}
              />
            </>
          )}

          <View
            style={{
              height: 360,
              borderRadius: theme.radius.xl,
              overflow: "hidden",
              backgroundColor: "#000",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {showCamera ? (
              <CameraView
                ref={cameraRef}
                style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}
                facing="back"
                autofocus="on"
                barcodeScannerSettings={{ barcodeTypes: [...NATIVE_BARCODE_TYPES] }}
                onBarcodeScanned={barcode ? undefined : handleBarcode}
                onMountError={(e) => setCameraError(e.message || "The camera couldn't start.")}
              />
            ) : (
              <CameraPlaceholder
                permissionLoaded={Boolean(permission)}
                granted={cameraAllowed}
                canAskAgain={permission?.canAskAgain ?? true}
                statesRetention={bottle}
                onRequest={() => void requestPermission()}
              />
            )}
            {showCamera && (
              <View pointerEvents="box-none" style={{ position: "absolute", left: 0, right: 0, bottom: 0, padding: theme.spacing(3), gap: theme.spacing(3) }}>
                {!bottle && (
                  <View style={{ flexDirection: "row", justifyContent: "center", gap: theme.spacing(2) }}>
                    {FRAME_TYPES.map((t) => (
                      <Chip key={t.type} label={t.label} selected={frameType === t.type} onPress={() => setFrameType(t.type)} />
                    ))}
                  </View>
                )}
                <View style={{ alignItems: "center" }}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Take a ${shotType} photo`}
                    disabled={busy === "capturing" || summary.total >= MAX_CAPTURE_FRAMES}
                    onPress={() => {
                      const shot = nextShot();
                      setManualType(null);
                      void takeFrame(shot.type, barcode, shot.surface);
                    }}
                    style={({ pressed }) => ({
                      width: 68,
                      height: 68,
                      borderRadius: 34,
                      borderWidth: 4,
                      borderColor: "#fff",
                      backgroundColor: pressed ? theme.colors.brand.pinkSoft : theme.colors.brand.pink,
                      opacity: busy === "capturing" || summary.total >= MAX_CAPTURE_FRAMES ? 0.5 : 1,
                    })}
                  />
                </View>
              </View>
            )}
            {showCamera && !barcode && (
              <View pointerEvents="none" style={{ position: "absolute", top: theme.spacing(3) }}>
                <Chip label={bottle ? "Or scan the barcode" : "Point at the barcode"} />
              </View>
            )}
          </View>

          {cameraError && <ErrorBanner message={`${cameraError} You can still pick a photo.`} />}

          {barcode && (
            <Card style={{ paddingVertical: theme.spacing(3) }}>
              <AppText variant="small">
                Barcode <AppText variant="small" style={{ fontWeight: "700", fontVariant: ["tabular-nums"] }}>{barcode.gtin}</AppText> scanned
                {busy === "checking" ? " — checking your collection…" : "."}
              </AppText>
            </Card>
          )}

          <FrameStrip frames={frames} onRetry={retryFrame} onRemove={removeFrame} />

          <View style={{ gap: theme.spacing(2) }}>
            <Button
              title={busy === "checking" ? "Checking…" : "Check my collection"}
              variant="brand"
              loading={busy === "checking"}
              disabled={!checkEnabled}
              onPress={() => void runCheck(barcode)}
              testID="rapid-add-check"
            />
            <AppText variant="tiny" muted style={{ textAlign: "center" }}>
              {summary.uploading > 0
                ? "Sending photos…"
                : "Checking never changes your collection — you choose what to add."}
            </AppText>
          </View>

          <View style={{ flexDirection: "row", gap: theme.spacing(2) }}>
            <Button title="Choose a photo" variant="outline" compact onPress={() => void pickFromLibrary()} style={{ flex: 1 }} />
            <Button title="Match a look" variant="outline" compact onPress={() => router.push("/match")} style={{ flex: 1 }} />
          </View>

          <Card>
            <Pressable accessibilityRole="button" onPress={() => setShowHints((v) => !v)}>
              <AppText style={{ fontWeight: "600" }}>{showHints ? "▾" : "▸"} Know the name? Add hints</AppText>
            </Pressable>
            {showHints && (
              <View style={{ gap: theme.spacing(2) }}>
                <AppText variant="tiny" muted>
                  {sessionStarted
                    ? "Hints are sent when a scan starts; they apply to your next scan."
                    : "Brand and shade help when there's no barcode. With hints alone, Check works without a photo."}
                </AppText>
                <HintInput
                  value={brandHint}
                  placeholder="Brand (e.g. OPI)"
                  editable={!sessionStarted}
                  onChangeText={(v) => {
                    setBrandHint(v);
                    hintsRef.current = { ...hintsRef.current, brand: v };
                  }}
                />
                <HintInput
                  value={shadeHint}
                  placeholder="Shade (e.g. Big Apple Red)"
                  editable={!sessionStarted}
                  onChangeText={(v) => {
                    setShadeHint(v);
                    hintsRef.current = { ...hintsRef.current, shadeName: v };
                  }}
                />
              </View>
            )}
          </Card>
        </>
      )}

      {shelf.entries.length > 0 && (
        <ShelfList
          entries={shelf.entries}
          repeatKey={shelf.repeatKey}
          busyKey={shelfBusyKey}
          now={now}
          onAction={(entry, action) => void shelfAction(entry, action)}
          onOpen={(entry) => entry.shadeId && router.push({ pathname: "/polishes/[id]", params: { id: entry.shadeId } })}
          onClear={() => {
            shelfKeyRef.current = null;
            dispatchShelf({ type: "cleared" });
          }}
        />
      )}

      {error && <ErrorBanner message={error} onRetry={verdict ? undefined : () => setError(null)} />}
    </ScrollView>
  );
}

function HintInput(props: { value: string; placeholder: string; editable: boolean; onChangeText: (v: string) => void }) {
  const theme = useTheme();
  return (
    <TextInput
      {...props}
      accessibilityLabel={props.placeholder}
      placeholderTextColor={theme.colors.mutedForeground}
      autoCorrect={false}
      style={{
        borderWidth: 1,
        borderColor: theme.colors.input,
        borderRadius: theme.radius.lg,
        paddingHorizontal: theme.spacing(3),
        paddingVertical: theme.spacing(2),
        color: theme.colors.foreground,
        opacity: props.editable ? 1 : 0.5,
      }}
    />
  );
}

function CameraPlaceholder({
  permissionLoaded,
  granted,
  canAskAgain,
  statesRetention,
  onRequest,
}: {
  permissionLoaded: boolean;
  granted: boolean;
  canAskAgain: boolean;
  /** Bottle sequence on: say how long the photos are kept. */
  statesRetention: boolean;
  onRequest: () => void;
}) {
  const theme = useTheme();
  if (Platform.OS === "web") {
    return (
      <AppText style={{ color: "#fff", textAlign: "center", padding: theme.spacing(6) }}>
        The camera scanner runs in the iOS / Android app. In this preview, choose a photo or type hints below.
      </AppText>
    );
  }
  if (!permissionLoaded || granted) return null;
  return (
    <View style={{ alignItems: "center", gap: theme.spacing(3), padding: theme.spacing(6) }}>
      <AppText style={{ color: "#fff", textAlign: "center" }}>
        Rapid Add needs the camera to scan barcodes and labels.{" "}
        {statesRetention
          ? "Photos are only sent to match this bottle and are kept for up to 24 hours."
          : "Photos are only sent to match this bottle."}
      </AppText>
      {canAskAgain ? (
        <Button title="Allow camera" variant="brand" onPress={onRequest} />
      ) : (
        <Button title="Open Settings" variant="brand" onPress={() => void Linking.openSettings()} />
      )}
    </View>
  );
}
