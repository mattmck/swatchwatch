import { CameraView, useCameraPermissions, type BarcodeScanningResult } from "expo-camera";
import * as Haptics from "expo-haptics";
import * as ImagePicker from "expo-image-picker";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useReducer, useRef, useState } from "react";
import { Linking, Platform, Pressable, ScrollView, TextInput, View } from "react-native";
import type { CaptureCheckCandidate, CaptureFrameType } from "swatchwatch-shared";
import {
  addCaptureFrame,
  ApiError,
  checkCapture,
  errorMessage,
  finalizeCapture,
  startCapture,
  updatePolish,
} from "@/api/client";
import { FrameStrip } from "@/components/frame-strip";
import { AppText, Button, Card, Chip, ErrorBanner } from "@/components/ui";
import { VerdictCard, type VerdictBusy } from "@/components/verdict-card";
import { fetchOwnedDupes } from "@/lib/add-guard";
import { prepareJpeg } from "@/lib/image-prep";
import {
  buildFrameQuality,
  buildStartMetadata,
  canCheck,
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

  // Values async callbacks need without re-creating them each render.
  const sessionPromise = useRef<Promise<string> | null>(null);
  const captureIdRef = useRef<string | null>(null);
  const barcodeLock = useRef(false);
  /** Bumped by "Scan next": async work from an earlier scan must not touch the new one. */
  const scanGeneration = useRef(0);
  const hintsRef = useRef({ brand: "", shadeName: "" });

  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );

  const ensureSession = useCallback((scanned: ScannedBarcode | null): Promise<string> => {
    if (!sessionPromise.current) {
      // Only the current scan's promise may write the refs: "Scan next" can replace it while
      // an older start request is still in flight.
      const promise: Promise<string> = startCapture({
        metadata: buildStartMetadata({ barcode: scanned, hints: hintsRef.current }),
      }).then(
        (started) => {
          if (sessionPromise.current === promise) {
            captureIdRef.current = started.captureId;
            setSessionStarted(true);
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
  }, []);

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
    [ensureSession],
  );

  const addFrame = useCallback(
    async (input: { uri: string; width: number; height: number; type: CaptureFrameType; source: "mobile-camera" | "mobile-library"; scanned: ScannedBarcode | null }) => {
      const prepared = await prepareJpeg(input.uri, input, { maxEdge: 1600, compress: 0.7 });
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
      setBusy("checking");
      setError(null);
      try {
        const captureId = await ensureSession(scanned);
        const res = await checkCapture(captureId);
        const next = await enrich(deriveVerdict(res, scanned?.gtin));
        if (generation !== scanGeneration.current) return;
        setVerdict(next);
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
    [ensureSession],
  );

  const takeFrame = useCallback(
    /** Resolves once the photo is taken and its upload has finished (or failed). */
    async (type: CaptureFrameType, scanned: ScannedBarcode | null): Promise<void> => {
      const camera = cameraRef.current;
      if (!camera) return;
      setBusy((b) => b ?? "capturing");
      let upload: Promise<void> = Promise.resolve();
      try {
        const picture = await camera.takePictureAsync({ quality: 0.8, shutterSound: false });
        ({ upload } = await addFrame({ uri: picture.uri, width: picture.width, height: picture.height, type, source: "mobile-camera", scanned }));
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

  async function pickFromLibrary() {
    setError(null);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 1 });
      const asset = result.canceled ? null : result.assets[0];
      if (!asset) return;
      await addFrame({
        uri: asset.uri,
        width: asset.width,
        height: asset.height,
        type: frameType === "barcode" ? "label" : frameType,
        source: "mobile-library",
        scanned: barcode,
      });
    } catch (err) {
      setError(errorMessage(err, "Couldn't use that photo."));
    }
  }

  function retryFrame(localId: string) {
    const frame = frames.find((f) => f.localId === localId);
    if (!frame) return;
    dispatchFrames({ type: "upload_started", localId });
    setError(null);
    void uploadFrame(frame, barcode);
  }

  async function addCandidate(candidate: CaptureCheckCandidate, status: "owned" | "wishlist") {
    setVerdictBusy(status);
    setError(null);
    try {
      if (candidate.shadeId) {
        const updated = await updatePolish(candidate.shadeId, status === "owned" ? { status, quantity: 1 } : { status });
        setVerdict({ kind: "added", candidate, status, quantity: updated.quantity });
      } else if (status === "owned" && captureIdRef.current) {
        // A barcode (SKU) match without a catalog shade: finalize adds it server-side.
        await finalizeCapture(captureIdRef.current);
        setVerdict({ kind: "added", candidate, status });
      }
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
    } catch (err) {
      setError(errorMessage(err, "Couldn't add it. Try again."));
    } finally {
      setVerdictBusy(null);
    }
  }

  async function addBottle(candidate: CaptureCheckCandidate, quantity: number) {
    if (!candidate.shadeId) return;
    setVerdictBusy("bottle");
    try {
      const updated = await updatePolish(candidate.shadeId, { status: "owned", quantity });
      setVerdict({ kind: "added", candidate, status: "owned", quantity: updated.quantity ?? quantity });
    } catch (err) {
      setError(errorMessage(err, "Couldn't update the bottle count."));
    } finally {
      setVerdictBusy(null);
    }
  }

  async function pickCandidate(candidate: CaptureCheckCandidate) {
    setVerdict(await enrich(verdictForCandidate(candidate)));
  }

  function scanLabel() {
    setVerdict(null);
    setFrameType("label");
  }

  function scanNext() {
    scanGeneration.current += 1;
    sessionPromise.current = null;
    captureIdRef.current = null;
    barcodeLock.current = false;
    hintsRef.current = { brand: "", shadeName: "" };
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
  const hasHints = Boolean(brandHint.trim() || shadeHint.trim());
  const checkEnabled = canCheck({ frames, hasBarcode: Boolean(barcode), hasHints, busy: busy === "checking" });
  const cameraAllowed = permission?.granted === true;
  const showCamera = focused && cameraAllowed && !verdict && Platform.OS !== "web";

  return (
    <ScrollView contentContainerStyle={{ padding: theme.spacing(4), gap: theme.spacing(4) }} keyboardShouldPersistTaps="handled">
      {verdict ? (
        <VerdictCard
          verdict={verdict}
          busy={verdictBusy}
          onAdd={(c, s) => void addCandidate(c, s)}
          onAddBottle={(c, q) => void addBottle(c, q)}
          onPick={(c) => void pickCandidate(c)}
          onNoneOfThese={() => setVerdict({ kind: "not-found", gtin: barcode?.gtin })}
          onScanLabel={scanLabel}
          onScanNext={scanNext}
        />
      ) : (
        <>
          <AppText muted>Scan a bottle to see if you already own it, then add it in one tap.</AppText>

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
                onRequest={() => void requestPermission()}
              />
            )}
            {showCamera && (
              <View pointerEvents="box-none" style={{ position: "absolute", left: 0, right: 0, bottom: 0, padding: theme.spacing(3), gap: theme.spacing(3) }}>
                <View style={{ flexDirection: "row", justifyContent: "center", gap: theme.spacing(2) }}>
                  {FRAME_TYPES.map((t) => (
                    <Chip key={t.type} label={t.label} selected={frameType === t.type} onPress={() => setFrameType(t.type)} />
                  ))}
                </View>
                <View style={{ alignItems: "center" }}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Take a ${frameType} photo`}
                    disabled={busy === "capturing" || summary.total >= MAX_CAPTURE_FRAMES}
                    onPress={() => void takeFrame(frameType, barcode)}
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
                <Chip label="Point at the barcode" />
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

          <FrameStrip frames={frames} onRetry={retryFrame} onRemove={(localId) => dispatchFrames({ type: "removed", localId })} />

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
  onRequest,
}: {
  permissionLoaded: boolean;
  granted: boolean;
  canAskAgain: boolean;
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
        Rapid Add needs the camera to scan barcodes and labels. Photos are only sent to match this bottle.
      </AppText>
      {canAskAgain ? (
        <Button title="Allow camera" variant="brand" onPress={onRequest} />
      ) : (
        <Button title="Open Settings" variant="brand" onPress={() => void Linking.openSettings()} />
      )}
    </View>
  );
}
