"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BottleSurface, CaptureFrameType } from "swatchwatch-shared";
import { Camera, CameraOff, CircleCheck, ImageUp, Info, ScanBarcode, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCameraStream } from "@/hooks/use-camera-stream";
import {
  armAutoShutter,
  AUTO_SHUTTER_BLOCKER_COPY,
  AUTO_SHUTTER_SETTINGS,
  stepAutoShutter,
  type AutoShutterStatus,
} from "@/lib/auto-shutter";
import {
  createBarcodeScanner,
  shouldReportLiveBarcode,
  type BarcodeEngine,
  type BarcodeScanner,
  type ScannedBarcode,
} from "@/lib/barcode-scan";
import { CAMERA_ERROR_COPY, type CameraErrorKind } from "@/lib/camera";
import {
  captureFrameFromFile,
  captureFrameFromSource,
  sampleLuminance,
  type CapturedFrame,
} from "@/lib/frame-capture";
import type { FrameSource } from "@/lib/rapid-add-flow";
import { safeLocalStorage } from "@/lib/sticky-hints-store";
import { cn } from "@/lib/utils";

/** How a capture was taken: a live barcode read, the Capture button, the auto-shutter, or an upload. */
export type CaptureTrigger = "live-scan" | "shutter" | "auto" | "file";

/** The outline drawn over the preview: what the user should fill it with. */
export type CameraGuide = "barcode" | "label" | BottleSurface;

const CENTERED = "left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2";

/** Outline sizes are in container percentages so they fit both the portrait and the 16:9 viewfinder. */
const GUIDE_CLASS: Record<CameraGuide, string> = {
  barcode: "inset-x-[12%] top-1/2 h-[28%] -translate-y-1/2 rounded-lg",
  label: `${CENTERED} h-[80%] aspect-[1/2] rounded-2xl`,
  front: `${CENTERED} h-[80%] aspect-[1/2] rounded-2xl`,
  bottom: `${CENTERED} h-[60%] aspect-square rounded-full`,
  glass: `${CENTERED} h-[35%] aspect-square rounded-lg`,
  box: `${CENTERED} h-[70%] aspect-square rounded-lg`,
};

const GUIDE_AUTO_HINT: Record<CameraGuide, string> = {
  barcode: "Hold the barcode in the band — it captures automatically",
  label: "Hold the label in the outline — it captures automatically",
  front: "Hold the front of the bottle in the outline — it captures automatically",
  bottom: "Hold the bottom sticker in the circle — it captures automatically",
  glass: "Fill the square with the polish color — it captures automatically",
  box: "Hold the box in the square — it captures automatically",
};

const GUIDE_MANUAL_HINT: Record<CameraGuide, string> = {
  barcode: "Point at the barcode — it scans automatically",
  label: "Frame the label, then tap Capture",
  front: "Frame the front of the bottle, then tap Capture",
  bottom: "Frame the bottom sticker, then tap Capture",
  glass: "Fill the square with the polish color, then tap Capture",
  box: "Frame the box, then tap Capture",
};

/** The guide for a frame type when the caller doesn't name one. */
export function defaultCameraGuide(frameType: CaptureFrameType): CameraGuide {
  if (frameType === "color") return "glass";
  if (frameType === "barcode") return "barcode";
  return "label";
}

/** A message shown over the live preview (scan result, repeat read, errors). */
export interface ViewfinderStatus {
  tone: "success" | "info" | "warning";
  text: string;
  action?: { label: string; onClick: () => void };
}

export interface CameraCaptureEvent {
  /** Null only when a live barcode read couldn't also snapshot the frame. */
  frame: CapturedFrame | null;
  frameType: CaptureFrameType;
  barcode: ScannedBarcode | null;
  source: FrameSource;
  trigger: CaptureTrigger;
  file?: File;
}

export interface CameraCaptureProps {
  /** Scan the live preview for a barcode (off once one is found or a verdict is shown). */
  scanBarcodes: boolean;
  /** Disable the shutter and upload (frame limit reached, or a request in flight). */
  captureDisabled: boolean;
  frameType: CaptureFrameType;
  onFrameTypeChange: (frameType: CaptureFrameType) => void;
  onCapture: (event: CameraCaptureEvent) => void;
  onCameraError?: (kind: CameraErrorKind) => void;
  /** Hide the Label/Barcode/Color chips when the caller sets the frame type itself (default false). */
  hideFrameTypeOptions?: boolean;
  /**
   * Arms the auto-shutter for one photo of `frameType`: a new key re-arms it, null turns it off.
   * It fires once per key, when the preview is steady, sharp and well exposed (`lib/auto-shutter.ts`).
   */
  autoCaptureKey?: string | null;
  /** Shown over the live preview, e.g. the result of the last barcode read. */
  status?: ViewfinderStatus | null;
  /** The outline to draw; defaults from `frameType` (`defaultCameraGuide`). */
  guide?: CameraGuide;
}

const AUTO_CAPTURE_STORAGE_KEY = "swatchwatch:rapid-add:auto-capture";
/** How long the guide box flashes green after a live barcode read. */
const READ_FLASH_MS = 700;

function readAutoCapturePreference(): boolean {
  try {
    return safeLocalStorage()?.getItem(AUTO_CAPTURE_STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

function writeAutoCapturePreference(on: boolean) {
  try {
    safeLocalStorage()?.setItem(AUTO_CAPTURE_STORAGE_KEY, on ? "on" : "off");
  } catch {
    // Private mode or blocked storage: the toggle still works for this visit.
  }
}

const STATUS_TONE_CLASS: Record<ViewfinderStatus["tone"], string> = {
  success: "bg-emerald-600/90 text-white",
  info: "bg-black/70 text-white",
  warning: "bg-amber-500/95 text-black",
};

const STATUS_TONE_ICON: Record<ViewfinderStatus["tone"], typeof Info> = {
  success: CircleCheck,
  info: Info,
  warning: TriangleAlert,
};

const FRAME_TYPE_OPTIONS: { value: CaptureFrameType; label: string }[] = [
  { value: "label", label: "Label" },
  { value: "barcode", label: "Barcode" },
  { value: "color", label: "Color" },
];

const LIVE_SCAN_INTERVAL_MS: Record<BarcodeEngine, number> = { native: 200, zxing: 400 };

const ENGINE_LABEL: Record<BarcodeEngine, string> = {
  native: "on-device scanner",
  zxing: "built-in scanner",
};

/**
 * Live rear-camera viewfinder with on-device barcode scanning, a shutter (and auto-shutter)
 * for label/color frames, and a photo-upload fallback that is always available (and the only
 * path when the camera is blocked, missing, or the page isn't served over https).
 *
 * The live scan keeps running after a read so a repeat or a new bottle is noticed; the same
 * code is reported again only every `LIVE_BARCODE_REPEAT_MS`, and the caller decides what a
 * read means (`planLiveBarcode`).
 */
export function CameraCapture({
  scanBarcodes,
  captureDisabled,
  frameType,
  onFrameTypeChange,
  onCapture,
  onCameraError,
  hideFrameTypeOptions = false,
  autoCaptureKey = null,
  status = null,
  guide: guideProp,
}: CameraCaptureProps) {
  const guide = guideProp ?? defaultCameraGuide(frameType);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const scannerRef = useRef<Promise<BarcodeScanner> | null>(null);
  const onCaptureRef = useRef(onCapture);
  const [engine, setEngine] = useState<BarcodeEngine | null>(null);
  const [scannerFailed, setScannerFailed] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [readFlash, setReadFlash] = useState(false);
  const [autoOn, setAutoOn] = useState(readAutoCapturePreference);
  const [autoStatus, setAutoStatus] = useState<AutoShutterStatus | null>(null);
  const lastReportedRef = useRef<{ gtin: string; at: number } | null>(null);
  const camera = useCameraStream(videoRef, { onError: onCameraError });
  const isLive = camera.state.phase === "live";
  const autoArmed = isLive && autoOn && autoCaptureKey !== null && !captureDisabled;

  useEffect(() => {
    if (!readFlash) return;
    const timer = setTimeout(() => setReadFlash(false), READ_FLASH_MS);
    return () => clearTimeout(timer);
  }, [readFlash]);

  useEffect(() => {
    onCaptureRef.current = onCapture;
  }, [onCapture]);

  const getScanner = useCallback((): Promise<BarcodeScanner> => {
    if (!scannerRef.current) {
      scannerRef.current = createBarcodeScanner().then(
        (scanner) => {
          setEngine(scanner.engine);
          return scanner;
        },
        (error: unknown) => {
          scannerRef.current = null;
          throw error;
        },
      );
    }
    return scannerRef.current;
  }, []);

  // Live scan loop: one detect at a time, paced per engine; keeps going after a read.
  useEffect(() => {
    if (!isLive || !scanBarcodes || scannerFailed) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      if (cancelled) return;
      let interval = LIVE_SCAN_INTERVAL_MS.zxing;
      try {
        const scanner = await getScanner();
        interval = LIVE_SCAN_INTERVAL_MS[scanner.engine];
        const video = videoRef.current;
        if (!cancelled && video && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          const barcode = await scanner.detect(video);
          if (cancelled) return;
          const now = Date.now();
          if (barcode && shouldReportLiveBarcode(lastReportedRef.current, barcode.gtin, now)) {
            lastReportedRef.current = { gtin: barcode.gtin, at: now };
            setReadFlash(true);
            navigator.vibrate?.(40);
            let frame: CapturedFrame | null = null;
            try {
              frame = captureFrameFromSource(video);
            } catch {
              frame = null;
            }
            onCaptureRef.current({ frame, frameType: "barcode", barcode, source: "web-camera", trigger: "live-scan" });
          }
        }
      } catch {
        if (!cancelled) setScannerFailed(true);
        return;
      }
      if (!cancelled) timer = setTimeout(tick, interval);
    };

    timer = setTimeout(tick, 300);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [getScanner, isLive, scanBarcodes, scannerFailed]);

  const shutterRef = useRef(handleShutter);
  const processingRef = useRef(processing);
  useEffect(() => {
    shutterRef.current = handleShutter;
    processingRef.current = processing;
  });

  // Auto-shutter: sample a small thumbnail of the preview and fire once per key when it is good.
  useEffect(() => {
    if (!autoArmed) return;
    let cancelled = false;
    let gate = armAutoShutter(Date.now());
    const scratch = document.createElement("canvas");
    const timer = setInterval(() => {
      const video = videoRef.current;
      if (cancelled || processingRef.current) return;
      if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
      const sample = sampleLuminance(video, scratch);
      if (!sample) return;
      const step = stepAutoShutter(gate, sample, Date.now(), frameType);
      gate = step.state;
      setAutoStatus(step.status);
      if (step.status.phase === "fire") {
        clearInterval(timer);
        void shutterRef.current("auto");
      }
    }, AUTO_SHUTTER_SETTINGS.sampleIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
      setAutoStatus(null);
    };
  }, [autoArmed, autoCaptureKey, frameType]);

  function toggleAuto() {
    setAutoOn((on) => {
      writeAutoCapturePreference(!on);
      return !on;
    });
  }

  async function detectStill(frame: CapturedFrame): Promise<ScannedBarcode | null> {
    try {
      const scanner = await getScanner();
      return await scanner.detect(frame.canvas, { thorough: true });
    } catch {
      return null;
    }
  }

  async function handleShutter(trigger: "shutter" | "auto" = "shutter") {
    const video = videoRef.current;
    if (!video) return;
    setLocalError(null);
    setProcessing(true);
    try {
      const frame = captureFrameFromSource(video);
      const barcode = await detectStill(frame);
      if (barcode) lastReportedRef.current = { gtin: barcode.gtin, at: Date.now() };
      onCaptureRef.current({
        frame,
        frameType: barcode ? "barcode" : frameType,
        barcode,
        source: "web-camera",
        trigger,
      });
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "Couldn't capture a frame.");
    } finally {
      setProcessing(false);
    }
  }

  async function handleFile(file: File | undefined) {
    if (!file) return;
    setLocalError(null);
    setProcessing(true);
    try {
      const frame = await captureFrameFromFile(file);
      const barcode = await detectStill(frame);
      onCaptureRef.current({
        frame,
        frameType: barcode ? "barcode" : frameType,
        barcode,
        source: "web-file-input",
        trigger: "file",
        file,
      });
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "Couldn't read that photo.");
    } finally {
      setProcessing(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  const blocked =
    camera.state.phase === "error"
      ? CAMERA_ERROR_COPY[camera.state.kind]
      : camera.state.phase === "unavailable"
        ? CAMERA_ERROR_COPY[camera.state.reason]
        : null;
  const canRetryCamera = camera.state.phase === "error";
  const liveHint = autoArmed
    ? processing
      ? "Capturing…"
      : autoStatus?.blocker
        ? AUTO_SHUTTER_BLOCKER_COPY[autoStatus.blocker]
        : autoStatus?.phase === "steadying"
          ? "Hold it there…"
          : GUIDE_AUTO_HINT[guide]
    : guide === "barcode" && scannerFailed
      ? "Frame the label or bottle, then tap Capture"
      : scanBarcodes && !scannerFailed && guide !== "barcode"
        ? `${GUIDE_MANUAL_HINT[guide]} (barcodes scan on their own)`
        : GUIDE_MANUAL_HINT[guide];

  return (
    <div className="space-y-3">
      <div
        className={cn(
          "relative overflow-hidden rounded-xl border border-border/60 bg-black",
          isLive ? "aspect-[3/4] sm:aspect-video" : "aspect-[4/3] sm:aspect-video",
        )}
      >
        <video
          ref={videoRef}
          className={cn("h-full w-full object-cover", !isLive && "hidden")}
          playsInline
          muted
          autoPlay
          aria-label="Live camera preview"
        />

        {isLive && (
          <>
            <div
              aria-hidden
              className={cn(
                "pointer-events-none absolute overflow-hidden border-2 shadow-[0_0_0_9999px_rgba(0,0,0,0.25)] transition-[border-color]",
                GUIDE_CLASS[guide],
                readFlash ? "border-emerald-400" : "border-white/80",
              )}
            >
              {autoArmed && autoStatus && autoStatus.progress > 0 && (
                <div
                  className="absolute inset-x-0 bottom-0 h-1 origin-left bg-emerald-400 transition-transform duration-150"
                  style={{ transform: `scaleX(${autoStatus.progress})` }}
                />
              )}
            </div>
            {status && <ViewfinderStatusPill status={status} />}
            <p
              className="absolute inset-x-0 bottom-3 px-3 text-center text-xs font-medium text-white drop-shadow"
              aria-live="polite"
            >
              {liveHint}
            </p>
          </>
        )}

        {!isLive && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center text-white">
            {blocked ? (
              <>
                <CameraOff className="size-8 opacity-80" aria-hidden />
                <div className="space-y-1">
                  <p className="font-semibold">{blocked.title}</p>
                  <p className="text-sm text-white/80">{blocked.description}</p>
                </div>
                {canRetryCamera && (
                  <Button type="button" variant="secondary" size="sm" onClick={() => void camera.start()}>
                    Try again
                  </Button>
                )}
              </>
            ) : (
              <>
                <Camera className="size-8 opacity-80" aria-hidden />
                <p className="text-sm text-white/80">
                  Scan a barcode or snap the label to check your collection.
                </p>
                <Button
                  type="button"
                  variant="brand"
                  onClick={() => void camera.start()}
                  disabled={camera.state.phase === "starting" || camera.state.phase === "checking"}
                >
                  {camera.state.phase === "starting" ? "Starting camera…" : "Start camera"}
                </Button>
              </>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {!hideFrameTypeOptions && (
          <div role="radiogroup" aria-label="Frame type" className="inline-flex rounded-lg border border-border/70 p-0.5">
            {FRAME_TYPE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={frameType === option.value}
                onClick={() => onFrameTypeChange(option.value)}
                className={cn(
                  "rounded-md px-3 py-1 text-xs font-medium transition-colors pointer-coarse:py-2.5",
                  frameType === option.value
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        )}

        <div className="ml-auto flex flex-wrap gap-2">
          {isLive && autoCaptureKey !== null && (
            <Button
              type="button"
              variant={autoOn ? "secondary" : "ghost"}
              size="sm"
              aria-pressed={autoOn}
              onClick={toggleAuto}
            >
              Auto-capture {autoOn ? "on" : "off"}
            </Button>
          )}
          {isLive && (
            <Button type="button" variant="ghost" size="sm" onClick={camera.stop}>
              Stop camera
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={captureDisabled || processing}
          >
            <ImageUp aria-hidden /> Upload photo
          </Button>
          {isLive && (
            <Button
              type="button"
              size="sm"
              onClick={() => void handleShutter()}
              disabled={captureDisabled || processing}
            >
              <Camera aria-hidden /> {processing ? "Capturing…" : "Capture"}
            </Button>
          )}
        </div>
        <label htmlFor="rapid-add-photo" className="sr-only">
          Upload a photo of the polish
        </label>
        <input
          ref={fileInputRef}
          id="rapid-add-photo"
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(event) => void handleFile(event.target.files?.[0])}
        />
      </div>

      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <ScanBarcode className="size-3.5" aria-hidden />
        {scannerFailed
          ? "Barcode scanning isn't available in this browser — capture the label instead."
          : engine
            ? `Barcodes are read on this device (${ENGINE_LABEL[engine]}).`
            : "Barcodes are read on this device."}
      </p>

      {localError && <p className="text-xs text-destructive">{localError}</p>}
    </div>
  );
}

function ViewfinderStatusPill({ status }: { status: ViewfinderStatus }) {
  const Icon = STATUS_TONE_ICON[status.tone];
  return (
    <div className="absolute inset-x-3 top-3 flex justify-center" role="status" aria-live="polite">
      <div
        className={cn(
          "flex max-w-full items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium shadow-lg backdrop-blur",
          STATUS_TONE_CLASS[status.tone],
        )}
      >
        <Icon className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">{status.text}</span>
        {status.action && (
          <button
            type="button"
            onClick={status.action.onClick}
            className="shrink-0 rounded-full bg-white/20 px-2 py-0.5 text-xs font-semibold underline-offset-2 hover:bg-white/30 pointer-coarse:py-1.5"
          >
            {status.action.label}
          </button>
        )}
      </div>
    </div>
  );
}
