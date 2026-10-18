"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import {
  buildCameraConstraints,
  classifyCameraError,
  getCameraAvailability,
  shouldRetryWithoutConstraints,
  type CameraAvailability,
  type CameraErrorKind,
} from "@/lib/camera";

type StreamPhase =
  | { phase: "idle" }
  | { phase: "starting" }
  | { phase: "live"; facingMode?: string }
  | { phase: "error"; kind: CameraErrorKind };

export type CameraStreamState =
  | { phase: "checking" }
  | StreamPhase
  | { phase: "unavailable"; reason: Exclude<CameraAvailability, "available"> };

const noopSubscribe = () => () => {};

function readAvailability(): CameraAvailability {
  return getCameraAvailability({
    isSecureContext: window.isSecureContext,
    hasGetUserMedia: typeof navigator.mediaDevices?.getUserMedia === "function",
  });
}

/** True when the browser says camera permission was already granted (no prompt needed). */
async function cameraPermissionGranted(): Promise<boolean> {
  try {
    const status = await navigator.permissions?.query({ name: "camera" as PermissionName });
    return status?.state === "granted";
  } catch {
    // Firefox and older Safari don't know the "camera" permission name.
    return false;
  }
}

/**
 * Owns a `getUserMedia` stream bound to `videoRef`: rear camera first, an unconstrained
 * retry on OverconstrainedError, and the camera released on stop, unmount, and when the
 * tab is hidden (so the phone's camera light doesn't stay on in the background).
 */
export function useCameraStream(
  videoRef: RefObject<HTMLVideoElement | null>,
  options: { onError?: (kind: CameraErrorKind) => void } = {},
) {
  // Availability can't change while the page is open; null during the static prerender.
  const availability = useSyncExternalStore<CameraAvailability | null>(noopSubscribe, readAvailability, () => null);
  const [streamState, setState] = useState<StreamPhase>({ phase: "idle" });
  const streamRef = useRef<MediaStream | null>(null);
  const startTokenRef = useRef(0);
  const onErrorRef = useRef(options.onError);

  useEffect(() => {
    onErrorRef.current = options.onError;
  }, [options.onError]);

  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    const video = videoRef.current;
    if (video) {
      video.srcObject = null;
    }
  }, [videoRef]);

  const stop = useCallback(() => {
    startTokenRef.current += 1;
    releaseStream();
    setState((prev) => (prev.phase === "live" || prev.phase === "starting" ? { phase: "idle" } : prev));
  }, [releaseStream]);

  const start = useCallback(async () => {
    if (readAvailability() !== "available") return;

    const token = ++startTokenRef.current;
    releaseStream();
    setState({ phase: "starting" });

    let stream: MediaStream;
    try {
      try {
        stream = await navigator.mediaDevices.getUserMedia(buildCameraConstraints("rear"));
      } catch (error) {
        if (!shouldRetryWithoutConstraints(classifyCameraError(error), error)) throw error;
        stream = await navigator.mediaDevices.getUserMedia(buildCameraConstraints("any"));
      }
    } catch (error) {
      if (token !== startTokenRef.current) return;
      const kind = classifyCameraError(error);
      setState({ phase: "error", kind });
      onErrorRef.current?.(kind);
      return;
    }

    if (token !== startTokenRef.current) {
      // Stopped (or restarted) while the permission prompt was open.
      stream.getTracks().forEach((track) => track.stop());
      return;
    }

    streamRef.current = stream;
    const video = videoRef.current;
    if (video) {
      video.srcObject = stream;
      try {
        await video.play();
      } catch {
        // Autoplay of a muted inline video is allowed everywhere we support; ignore aborts
        // from a quick stop/start.
      }
    }
    const settings = stream.getVideoTracks()[0]?.getSettings?.();
    setState({ phase: "live", facingMode: settings?.facingMode });
  }, [releaseStream, videoRef]);

  // Auto-start when camera permission was already granted (no prompt on page load).
  useEffect(() => {
    if (availability !== "available") return;
    let cancelled = false;
    void cameraPermissionGranted().then((granted) => {
      if (!cancelled && granted) void start();
    });
    return () => {
      cancelled = true;
    };
  }, [availability, start]);

  useEffect(() => {
    function handleVisibility() {
      if (document.visibilityState === "hidden" && streamRef.current) {
        stop();
      }
    }
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [stop]);

  useEffect(() => {
    return () => {
      startTokenRef.current += 1;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };
  }, []);

  const state: CameraStreamState =
    availability === null
      ? { phase: "checking" }
      : availability !== "available"
        ? { phase: "unavailable", reason: availability }
        : streamState;

  return { state, start, stop };
}
