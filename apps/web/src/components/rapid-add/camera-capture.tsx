"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CaptureFrameType } from "swatchwatch-shared";
import { Camera, CameraOff, ImageUp, ScanBarcode } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCameraStream } from "@/hooks/use-camera-stream";
import {
  createBarcodeScanner,
  type BarcodeEngine,
  type BarcodeScanner,
  type ScannedBarcode,
} from "@/lib/barcode-scan";
import { CAMERA_ERROR_COPY, type CameraErrorKind } from "@/lib/camera";
import { captureFrameFromFile, captureFrameFromSource, type CapturedFrame } from "@/lib/frame-capture";
import type { FrameSource } from "@/lib/rapid-add-flow";
import { cn } from "@/lib/utils";

export interface CameraCaptureEvent {
  /** Null only when a live barcode read couldn't also snapshot the frame. */
  frame: CapturedFrame | null;
  frameType: CaptureFrameType;
  barcode: ScannedBarcode | null;
  source: FrameSource;
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
}

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
 * Live rear-camera viewfinder with on-device barcode scanning, a shutter for label/color
 * frames, and a photo-upload fallback that is always available (and the only path when
 * the camera is blocked, missing, or the page isn't served over https).
 */
export function CameraCapture({
  scanBarcodes,
  captureDisabled,
  frameType,
  onFrameTypeChange,
  onCapture,
  onCameraError,
}: CameraCaptureProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const scannerRef = useRef<Promise<BarcodeScanner> | null>(null);
  const onCaptureRef = useRef(onCapture);
  const [engine, setEngine] = useState<BarcodeEngine | null>(null);
  const [scannerFailed, setScannerFailed] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const camera = useCameraStream(videoRef, { onError: onCameraError });
  const isLive = camera.state.phase === "live";

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

  // Live scan loop: one detect at a time, paced per engine; stops at the first valid code.
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
          if (barcode) {
            let frame: CapturedFrame | null = null;
            try {
              frame = captureFrameFromSource(video);
            } catch {
              frame = null;
            }
            onCaptureRef.current({ frame, frameType: "barcode", barcode, source: "web-camera" });
            return;
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

  async function detectStill(frame: CapturedFrame): Promise<ScannedBarcode | null> {
    try {
      const scanner = await getScanner();
      return await scanner.detect(frame.canvas, { thorough: true });
    } catch {
      return null;
    }
  }

  async function handleShutter() {
    const video = videoRef.current;
    if (!video) return;
    setLocalError(null);
    setProcessing(true);
    try {
      const frame = captureFrameFromSource(video);
      const barcode = await detectStill(frame);
      onCaptureRef.current({
        frame,
        frameType: barcode ? "barcode" : frameType,
        barcode,
        source: "web-camera",
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
              className="pointer-events-none absolute inset-x-[12%] top-1/2 h-[28%] -translate-y-1/2 rounded-lg border-2 border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.25)]"
            />
            <p
              className="absolute inset-x-0 bottom-3 text-center text-xs font-medium text-white drop-shadow"
              aria-live="polite"
            >
              {scanBarcodes && !scannerFailed
                ? "Point at the barcode — it scans automatically"
                : "Frame the label or bottle, then tap Capture"}
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

        <div className="ml-auto flex flex-wrap gap-2">
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
