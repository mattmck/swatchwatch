"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Camera, ImageOff, Lock, RefreshCw, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import type { NailPhoto } from "swatchwatch-shared";
import { ApiError, deleteNailPhoto, getNailPhoto, uploadNailPhoto } from "@/lib/api";
import { describeNailPhotoError, NAIL_PHOTO_INPUT_ACCEPT, prepareNailPhotoUpload } from "@/lib/nail-photo";
import { PrivateImage } from "@/components/private-image";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface NailPhotoPanelProps {
  /** The caller's inventory row for this polish. */
  inventoryItemId: string;
  /** "Brand Name", used for alt text. */
  polishLabel: string;
  vendorHex?: string;
  detectedHex?: string;
  nameHex?: string;
}

type LoadState = "loading" | "ready" | "error";

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return describeNailPhotoError(error.status, error.message);
  return error instanceof Error ? error.message : describeNailPhotoError(undefined);
}

function SwatchTile({ hex, label }: { hex?: string; label: string }) {
  return (
    <figure className="flex flex-col items-center gap-1.5">
      <div
        className="size-24 rounded-xl border shadow-sm sm:size-28"
        style={{ backgroundColor: hex || undefined }}
        role="img"
        aria-label={hex ? `${label} color ${hex}` : `${label} color unknown`}
      >
        {!hex && (
          <div className="flex size-full items-center justify-center rounded-xl bg-muted text-xs text-muted-foreground">
            —
          </div>
        )}
      </div>
      <figcaption className="text-center text-[11px] leading-tight text-muted-foreground">
        {label}
        {hex && <span className="block font-mono">{hex}</span>}
      </figcaption>
    </figure>
  );
}

/**
 * The caller's private on-nail photo for one inventory item (#270), shown
 * beside the vendor / AI-detected swatches. Upload (file or camera), replace and
 * delete. The photo is an owner-scoped `v3` image URL rendered with
 * `PrivateImage`, which sends the bearer token; the server strips EXIF/GPS.
 */
export function NailPhotoPanel({ inventoryItemId, polishLabel, vendorHex, detectedHex, nameHex }: NailPhotoPanelProps) {
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [photo, setPhoto] = useState<NailPhoto | null>(null);
  const [busy, setBusy] = useState<"uploading" | "deleting" | null>(null);
  const [imageAttempt, setImageAttempt] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  const fetchPhoto = useCallback(
    (isCancelled: () => boolean = () => false) =>
      getNailPhoto(inventoryItemId).then(
        (response) => {
          if (isCancelled()) return;
          setPhoto(response.photo);
          setLoadState("ready");
        },
        (error: unknown) => {
          if (isCancelled()) return;
          setLoadError(errorMessage(error));
          setLoadState("error");
        }
      ),
    [inventoryItemId]
  );

  // Initial load; the parent keys this component by inventory item, so state starts as "loading".
  useEffect(() => {
    let cancelled = false;
    void fetchPhoto(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [fetchPhoto]);

  const reload = () => {
    setLoadState("loading");
    setLoadError(null);
    void fetchPhoto();
  };

  async function handleFiles(files: FileList | null) {
    const file = files?.[0];
    if (!file || busy) return;
    setBusy("uploading");
    try {
      const image = await prepareNailPhotoUpload(file);
      const response = await uploadNailPhoto(inventoryItemId, image);
      setPhoto(response.photo);
      setImageAttempt((n) => n + 1);
      setLoadState("ready");
      toast.success(photo ? "Nail photo replaced" : "Nail photo added", {
        description: "Only you can see it. Location and camera details were removed.",
      });
    } catch (error) {
      toast.error("Upload failed", { description: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  }

  async function handleDelete() {
    if (!photo || busy || !confirm("Delete your nail photo for this polish?")) return;
    setBusy("deleting");
    try {
      await deleteNailPhoto(inventoryItemId);
      setPhoto(null);
      toast.success("Nail photo deleted");
    } catch (error) {
      toast.error("Delete failed", { description: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  }

  const retryImage = () => {
    // Fetch fresh metadata (a new signed URL if the old one expired) and remount the image.
    setImageAttempt((n) => n + 1);
    reload();
  };

  const imageFallback = (
    <div className="flex size-full flex-col items-center justify-center gap-2 rounded-xl bg-muted p-2 text-center text-xs text-muted-foreground">
      <ImageOff className="size-5" aria-hidden="true" />
      <span>Couldn&apos;t load your photo.</span>
      <Button type="button" variant="ghost" size="xs" onClick={retryImage}>
        <RefreshCw aria-hidden="true" />
        Retry
      </Button>
    </div>
  );

  let photoTile: ReactNode;
  if (loadState === "loading") {
    photoTile = <div aria-busy="true" className="size-full animate-pulse rounded-xl bg-muted" />;
  } else if (loadState === "error") {
    photoTile = (
      <div className="flex size-full flex-col items-center justify-center gap-2 rounded-xl bg-muted p-2 text-center text-xs text-muted-foreground">
        <ImageOff className="size-5" aria-hidden="true" />
        <span>{loadError}</span>
        <Button type="button" variant="ghost" size="xs" onClick={reload}>
          <RefreshCw aria-hidden="true" />
          Retry
        </Button>
      </div>
    );
  } else if (photo?.imageUrl) {
    photoTile = (
      <PrivateImage
        key={`${photo.imageUrl}#${imageAttempt}`}
        src={photo.imageUrl}
        alt={`${polishLabel} on the nail`}
        className="size-full rounded-xl object-cover"
        fallback={imageFallback}
      />
    );
  } else if (photo) {
    // Stored but the server could not sign a URL for it.
    photoTile = imageFallback;
  } else {
    photoTile = (
      <div className="flex size-full flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-brand-purple/25 bg-muted/30 p-2 text-center text-xs text-muted-foreground">
        <Camera className="size-5" aria-hidden="true" />
        <span>No nail photo yet</span>
      </div>
    );
  }

  const disabled = busy !== null || loadState !== "ready";

  return (
    <Card className="relative overflow-hidden">
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-1 bg-gradient-to-b from-brand-pink-soft via-brand-purple to-brand-lilac"
      />
      <CardHeader>
        <CardTitle>On the nail</CardTitle>
        <CardDescription className="flex items-center gap-1.5">
          <Lock className="size-3.5" aria-hidden="true" />
          Private to you. Bottle shots lie; your own photo doesn&apos;t.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-start gap-4">
          <figure className="flex flex-col items-center gap-1.5">
            <div className="size-36 overflow-hidden rounded-xl border shadow-sm sm:size-40">{photoTile}</div>
            <figcaption className="text-[11px] text-muted-foreground">Your nail photo</figcaption>
          </figure>
          {vendorHex && <SwatchTile hex={vendorHex} label="Vendor" />}
          {detectedHex && <SwatchTile hex={detectedHex} label="AI detected" />}
          {!vendorHex && !detectedHex && <SwatchTile hex={nameHex} label="From name" />}
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            disabled={disabled}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload aria-hidden="true" />
            {busy === "uploading" ? "Uploading…" : photo ? "Replace photo" : "Choose photo"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => cameraInputRef.current?.click()}
          >
            <Camera aria-hidden="true" />
            Take photo
          </Button>
          {photo && (
            <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={handleDelete}>
              <Trash2 aria-hidden="true" />
              {busy === "deleting" ? "Deleting…" : "Delete photo"}
            </Button>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept={NAIL_PHOTO_INPUT_ACCEPT}
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(event) => {
              void handleFiles(event.target.files);
              event.target.value = "";
            }}
          />
          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(event) => {
              void handleFiles(event.target.files);
              event.target.value = "";
            }}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Location and camera details are removed before the photo is stored.
        </p>
      </CardContent>
    </Card>
  );
}
