"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BottleSurface, CaptureFrameType } from "swatchwatch-shared";
import { Camera, CameraOff, CircleCheck, ImageUp, Info, ScanBarcode, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCameraStream } from "@/hooks/use-camera-stream";
import {
  armAutoShutter,
  AUTO_SHUTTER_BLOCKER_COPY,
  AUTO_SHUTTER_REGIONS,
  AUTO_SHUTTER_SETTINGS,
  AUTO_SHUTTER_STALLED_COPY,
  cropLuminance,
  skinFraction,
  stepAutoShutter,
  type AutoShutterArrival,
  type AutoShutterBlocker,
  type AutoShutterState,
  type AutoShutterStatus,
} from "@/lib/auto-shutter";
import {
  createBarcodeScanner,
  shouldReportLiveBarcode,
  type BarcodeEngine,
  type BarcodeScanner,
  type ScannedBarcode,
} from "@/lib/barcode-scan";
import { CAMERA_ERROR_COPY, computeFrameQuality, type CameraErrorKind, type FrameQualityMetrics } from "@/lib/camera";
import {
  captureFrameFromFile,
  captureFrameFromSource,
  sampleLuminance,
  type CapturedFrame,
  type LuminanceSample,
} from "@/lib/frame-capture";
import { guideRegionInFrame, planGuideCrop, scaleRegion, type ShownGuide } from "@/lib/guide-region";
import type { FrameSource } from "@/lib/rapid-add-flow";
import { safeLocalStorage } from "@/lib/sticky-hints-store";
import { cn } from "@/lib/utils";

/** How a capture was taken: a live barcode read, the Capture button, the auto-shutter, or an upload. */
export type CaptureTrigger = "live-scan" | "shutter" | "auto" | "file";

/** The outline drawn over the preview: what the user should fill it with. */
export type CameraGuide = "barcode" | "label" | BottleSurface;

const CENTERED = "left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2";

/**
 * Outline sizes are in container percentages so they fit both the portrait and the 16:9
 * viewfinder. They are sized so a bottle that fits its outline is about 15 cm (6 in) from a
 * phone: closer than that an iPhone Pro's main camera cannot focus, and the old, larger outlines
 * asked for exactly that (a bottle's bottom filled its circle at about 4 cm). The photo is cut
 * around the outline (`planGuideCrop`), so the bottle still fills what is uploaded.
 */
const GUIDE_CLASS: Record<CameraGuide, string> = {
  barcode: "inset-x-[12%] top-1/2 h-[28%] -translate-y-1/2 rounded-lg",
  label: `${CENTERED} h-[60%] aspect-[1/2] rounded-2xl`,
  front: `${CENTERED} h-[60%] aspect-[1/2] rounded-2xl`,
  bottom: `${CENTERED} h-[22%] aspect-square rounded-full`,
  glass: `${CENTERED} h-[18%] aspect-square rounded-lg`,
  box: `${CENTERED} h-[60%] aspect-square rounded-lg`,
};

const GUIDE_AUTO_HINT: Record<CameraGuide, string> = {
  barcode: "Hold the barcode in the band. It captures by itself.",
  label: "Hold the label still in the outline, about 6 in away, or tap the picture.",
  front: "Hold the front of the bottle still in the outline, about 6 in away, or tap the picture.",
  bottom: "Hold the bottom sticker still over the circle, about 6 in away, or tap the picture.",
  glass: "Hold the polish color still over the square, or tap the picture. Blurry is fine.",
  box: "Hold the box still in the square, or tap the picture.",
};

const GUIDE_MANUAL_HINT: Record<CameraGuide, string> = {
  barcode: "Point at the barcode — it scans automatically",
  label: "Hold the label in the outline, about 6 in away, then tap the picture",
  front: "Hold the front of the bottle in the outline, about 6 in away, then tap the picture",
  bottom: "Hold the bottom sticker over the circle, about 6 in away, then tap the picture",
  glass: "Hold the polish color over the square, then tap the picture",
  box: "Hold the box in the square, then tap the picture",
};

/** What the viewfinder says for a moment after a photo is taken. */
const GUIDE_SHOT_LABEL: Record<CameraGuide, string> = {
  barcode: "Photo taken",
  label: "Label photo taken",
  front: "Front photo taken",
  bottom: "Bottom photo taken",
  glass: "Color photo taken",
  box: "Box photo taken",
};

/** How long the photo just taken stays on the viewfinder, so it is clear what was captured. */
const SHOT_FEEDBACK_MS = 800;
/** The same barcode read again within this long does not show "Barcode read" again. */
const BARCODE_CHIP_REPEAT_MS = 20_000;
/** A live barcode read's own snapshot is only kept as evidence (the server never reads it). */
const BARCODE_FRAME_MAX_EDGE = 800;

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
  /**
   * The outline drawn over the preview when a shutter or auto-shutter photo was taken, as
   * fractions of `frame`, which is cut around it (`planGuideCrop`); absent for uploads, live
   * reads, or when it could not be measured exactly.
   */
  shownGuide?: ShownGuide;
  /**
   * With a live barcode read while a bottle surface is outlined: the same moment as a photo of
   * that surface (cut around the outline, with how sharp and bright the outline's region was), so
   * the caller can use it instead of asking for the surface again.
   */
  surfaceStill?: SurfaceStill;
}

export interface SurfaceStill {
  frame: CapturedFrame;
  shownGuide?: ShownGuide;
  /** Quality of the outline's region of the preview when the barcode was read. */
  regionMetrics: FrameQualityMetrics | null;
}

/** One auto-shutter photo, for telemetry: how long it took and what held it up. */
export interface AutoShutterReport {
  guide: CameraGuide;
  frameType: CaptureFrameType;
  arrival: AutoShutterArrival;
  /** Milliseconds from the prompt arming to the photo. */
  ms: number;
  /** Samples each check held up. */
  blockers: Partial<Record<AutoShutterBlocker, number>>;
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
   * It fires at most once per key, on a deliberate hold of the bottle in the outline
   * (`lib/auto-shutter.ts`). It has no fallback: without such a hold it waits, and the photo is
   * taken by a tap on the picture or the Capture button.
   */
  autoCaptureKey?: string | null;
  /** What the auto-shutter waits for before a photo (`AutoShutterArrival`, default `empty`). */
  autoCaptureArrival?: AutoShutterArrival;
  /** Called with each auto-shutter photo's timing, for telemetry. */
  onAutoShutter?: (report: AutoShutterReport) => void;
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
  autoCaptureArrival = "empty",
  onAutoShutter,
  status = null,
  guide: guideProp,
}: CameraCaptureProps) {
  const guide = guideProp ?? defaultCameraGuide(frameType);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const guideRef = useRef<HTMLDivElement | null>(null);
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
  /** The photo just taken (or a barcode read), shown over the preview for a moment. */
  const [shot, setShot] = useState<{ text: string; imageUrl?: string } | null>(null);
  const lastReportedRef = useRef<{ gtin: string; at: number } | null>(null);
  /** The preview thumbnail at the last photo: what the next prompt's outline must differ from. */
  const lastShotRef = useRef<LuminanceSample | null>(null);
  const onAutoShutterRef = useRef(onAutoShutter);
  /** The barcode the "Barcode read" confirmation was last shown for: repeat reads stay quiet. */
  const lastChipRef = useRef<{ gtin: string; at: number } | null>(null);
  const camera = useCameraStream(videoRef, { onError: onCameraError });
  const isLive = camera.state.phase === "live";
  const autoArmed = isLive && autoOn && autoCaptureKey !== null && !captureDisabled;

  useEffect(() => {
    if (!readFlash) return;
    const timer = setTimeout(() => setReadFlash(false), READ_FLASH_MS);
    return () => clearTimeout(timer);
  }, [readFlash]);

  useEffect(() => {
    if (!shot) return;
    const timer = setTimeout(() => setShot(null), SHOT_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [shot]);

  useEffect(() => {
    onCaptureRef.current = onCapture;
    onAutoShutterRef.current = onAutoShutter;
  }, [onCapture, onAutoShutter]);

  /**
   * Where the drawn outline lies in the video frame right now. The preview is `object-cover` and
   * not mirrored (`<video>` below), so these are fractions of the whole camera frame.
   */
  const measureShownGuide = useCallback(
    (video: HTMLVideoElement): ShownGuide | undefined => {
      const outline = guideRef.current;
      if (!outline) return undefined;
      const box = video.getBoundingClientRect();
      const drawn = outline.getBoundingClientRect();
      const region = guideRegionInFrame({
        guide: { left: drawn.left - box.left, top: drawn.top - box.top, width: drawn.width, height: drawn.height },
        element: { width: box.width, height: box.height },
        frame: { width: video.videoWidth, height: video.videoHeight },
      });
      return region ? { guide, region } : undefined;
    },
    [guide],
  );

  /** The part of the camera frame the preview shows (it is `object-cover`), as fractions of the frame. */
  const visibleRegion = useCallback((video: HTMLVideoElement) => {
    const box = video.getBoundingClientRect();
    return (
      guideRegionInFrame({
        guide: { left: 0, top: 0, width: box.width, height: box.height },
        element: { width: box.width, height: box.height },
        frame: { width: video.videoWidth, height: video.videoHeight },
      }) ?? { x: 0, y: 0, w: 1, h: 1 }
    );
  }, []);

  /** The part of the preview thumbnail the auto-shutter measures: a little inside the outline. */
  const measuredRegion = useCallback(
    (video: HTMLVideoElement) => {
      const shown = measureShownGuide(video);
      return shown ? scaleRegion(shown.region, 0.9) : AUTO_SHUTTER_REGIONS[guide];
    },
    [guide, measureShownGuide],
  );

  /** A photo of the live video, cut around the outline. */
  const takeStill = useCallback(
    (video: HTMLVideoElement) => {
      const shown = measureShownGuide(video);
      const plan = shown ? planGuideCrop(guide, shown.region) : null;
      const frame = captureFrameFromSource(video, undefined, plan?.crop);
      const shownGuide: ShownGuide | undefined = plan?.region ? { guide, region: plan.region } : undefined;
      return { frame, shownGuide };
    },
    [guide, measureShownGuide],
  );

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
            let surfaceStill: SurfaceStill | undefined;
            try {
              frame = captureFrameFromSource(video, BARCODE_FRAME_MAX_EDGE);
              // A sticker with a barcode usually carries the name too: keep this moment as a photo of the outlined surface.
              if (guide === "bottom") {
                const sample = sampleLuminance(video);
                const region = sample
                  ? cropLuminance(sample.luminance, sample.width, sample.height, measuredRegion(video))
                  : null;
                surfaceStill = {
                  ...takeStill(video),
                  regionMetrics: region ? computeFrameQuality(region.luminance, region.width, region.height) : null,
                };
                if (sample) lastShotRef.current = sample;
              }
            } catch {
              surfaceStill = undefined;
            }
            const chip = lastChipRef.current;
            if (!chip || chip.gtin !== barcode.gtin || now - chip.at > BARCODE_CHIP_REPEAT_MS) {
              setShot({ text: "Barcode read" });
            }
            lastChipRef.current = { gtin: barcode.gtin, at: now };
            onCaptureRef.current({
              frame,
              frameType: "barcode",
              barcode,
              source: "web-camera",
              trigger: "live-scan",
              surfaceStill,
            });
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
  }, [getScanner, isLive, scanBarcodes, scannerFailed, guide, measuredRegion, takeStill]);

  const shutterRef = useRef(handleShutter);
  const processingRef = useRef(processing);
  useEffect(() => {
    shutterRef.current = handleShutter;
    processingRef.current = processing;
  });

  // Auto-shutter: sample a small thumbnail of the preview and take one photo per key.
  useEffect(() => {
    if (!autoArmed) return;
    let cancelled = false;
    let gate: AutoShutterState | null = null;
    const blockers: Partial<Record<AutoShutterBlocker, number>> = {};
    const scratch = document.createElement("canvas");
    // A new bottle starts from the empty scene, not from the last bottle's photo.
    if (autoCaptureArrival === "empty") lastShotRef.current = null;
    const timer = setInterval(() => {
      const video = videoRef.current;
      if (cancelled || processingRef.current) return;
      if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
      const sample = sampleLuminance(video, scratch);
      if (!sample) return;
      // The outline's region says whether the photo would be good; the whole view the user sees
      // says whether the phone or the bottle is moving.
      const area = measuredRegion(video);
      const visible = visibleRegion(video);
      const region = cropLuminance(sample.luminance, sample.width, sample.height, area);
      const scene = cropLuminance(sample.luminance, sample.width, sample.height, visible);
      const now = Date.now();
      if (!gate) {
        const last = lastShotRef.current;
        gate = armAutoShutter(now, {
          arrival: autoCaptureArrival,
          reference: last
            ? {
                scene: cropLuminance(last.luminance, last.width, last.height, visible),
                region: cropLuminance(last.luminance, last.width, last.height, area),
              }
            : null,
        });
      }
      const step = stepAutoShutter(
        gate,
        {
          ...region,
          metrics: computeFrameQuality(region.luminance, region.width, region.height),
          scene,
          skin: skinFraction(sample.rgba, sample.width, sample.height, area),
        },
        now,
        frameType,
      );
      const armedAt = gate.armedAt;
      const arrival = gate.arrival;
      gate = step.state;
      setAutoStatus(step.status);
      if (step.status.blocker) blockers[step.status.blocker] = (blockers[step.status.blocker] ?? 0) + 1;
      if (step.status.phase === "fire") {
        clearInterval(timer);
        onAutoShutterRef.current?.({ guide, frameType, arrival, ms: now - armedAt, blockers });
        void shutterRef.current("auto");
      }
    }, AUTO_SHUTTER_SETTINGS.sampleIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
      setAutoStatus(null);
    };
  }, [autoArmed, autoCaptureKey, autoCaptureArrival, frameType, guide, measuredRegion, visibleRegion]);

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
      const { frame, shownGuide } = takeStill(video);
      lastShotRef.current = sampleLuminance(video);
      // Say so at once: reading the photo takes the server a few seconds.
      setShot({ text: GUIDE_SHOT_LABEL[guide], imageUrl: frame.dataUrl });
      navigator.vibrate?.(40);
      const barcode = await detectStill(frame);
      if (barcode) lastReportedRef.current = { gtin: barcode.gtin, at: Date.now() };
      onCaptureRef.current({
        frame,
        frameType: barcode ? "barcode" : frameType,
        barcode,
        source: "web-camera",
        trigger,
        shownGuide,
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
      setShot({ text: "Photo added", imageUrl: frame.dataUrl });
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
      : autoStatus?.stalled && autoCaptureArrival !== "none"
        ? AUTO_SHUTTER_STALLED_COPY[autoCaptureArrival]
        : autoStatus?.blocker && autoStatus.blocker !== "unchanged"
          ? AUTO_SHUTTER_BLOCKER_COPY[autoStatus.blocker]
          : autoStatus?.phase === "steadying"
            ? "Hold it there…"
            : GUIDE_AUTO_HINT[guide]
    : guide === "barcode" && scannerFailed
      ? "Frame the label or bottle, then tap the picture"
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
        {isLive && (guide !== "barcode" || scannerFailed) && (
          // The whole picture is a shutter: the auto-shutter only fires on a deliberate hold,
          // and a tap is the quick way to take the photo now. (The Capture button below does
          // the same and is the keyboard and screen-reader control.) Not over the barcode band,
          // where the live scan does the work, unless the scanner is unavailable: the hint then
          // asks for a tap on the picture.
          <div
            aria-hidden
            className={cn("absolute inset-0", !(captureDisabled || processing) && "cursor-pointer")}
            onClick={() => {
              if (!captureDisabled && !processing) void handleShutter();
            }}
          />
        )}

        {isLive && (
          <>
            <div
              ref={guideRef}
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
            {shot?.imageUrl && (
              // The photo just taken, held on screen for a moment: what was captured, and that it was.
              <div className="absolute inset-0 flex items-center justify-center bg-black/85" aria-hidden>
                {/* eslint-disable-next-line @next/next/no-img-element -- a data URL of the frame just captured */}
                <img
                  src={shot.imageUrl}
                  alt=""
                  className="max-h-full max-w-full rounded-lg object-contain ring-4 ring-emerald-400"
                />
              </div>
            )}
            {shot && (
              <div className="absolute inset-x-3 top-1/2 flex -translate-y-1/2 justify-center" role="status" aria-live="polite">
                <div className="flex items-center gap-2 rounded-full bg-emerald-600 px-4 py-2 text-base font-semibold text-white shadow-lg">
                  <CircleCheck className="size-5 shrink-0" aria-hidden />
                  {shot.text}
                </div>
              </div>
            )}
            {status && <ViewfinderStatusPill status={status} />}
            <p
              className="pointer-events-none absolute inset-x-0 bottom-3 px-3 text-center text-xs font-medium text-white drop-shadow"
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
    // Click-through, so a tap on the pill's band still takes the photo; only its action button takes taps.
    <div className="pointer-events-none absolute inset-x-3 top-3 flex justify-center" role="status" aria-live="polite">
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
            onClick={(event) => {
              event.stopPropagation();
              status.action?.onClick();
            }}
            className="pointer-events-auto shrink-0 rounded-full bg-white/20 px-2 py-0.5 text-xs font-semibold underline-offset-2 hover:bg-white/30 pointer-coarse:py-1.5"
          >
            {status.action.label}
          </button>
        )}
      </div>
    </div>
  );
}
