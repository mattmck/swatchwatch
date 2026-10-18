"use client";

import { useRef, type ReactNode } from "react";
import { Camera, Upload } from "lucide-react";
import { NAIL_PHOTO_INPUT_ACCEPT } from "@/lib/nail-photo";
import { Button } from "@/components/ui/button";

interface PhotoPickerButtonsProps {
  /** Called with the picked or captured file (the inputs reset so the same file can be re-picked). */
  onFile: (file: File) => void;
  disabled?: boolean;
  /** Label of the file-picker button, e.g. "Choose photo", "Replace photo" or "Uploading…". */
  chooseLabel: string;
  /** Extra buttons rendered after the pickers (e.g. "Delete photo"). */
  children?: ReactNode;
}

/**
 * "Choose photo" (file picker, accepts JPEG/PNG/WebP/HEIC) and "Take photo" (rear camera) buttons
 * for private photo uploads, shared by the nail-photo panel and the mani log form. Pair with
 * `prepareNailPhotoUpload`, which converts HEIC and strips metadata before upload.
 */
export function PhotoPickerButtons({ onFile, disabled, chooseLabel, children }: PhotoPickerButtonsProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) onFile(file);
  };

  return (
    <div className="flex flex-wrap gap-2">
      <Button type="button" size="sm" disabled={disabled} onClick={() => fileInputRef.current?.click()}>
        <Upload aria-hidden="true" />
        {chooseLabel}
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
      {children}
      <input
        ref={fileInputRef}
        type="file"
        accept={NAIL_PHOTO_INPUT_ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={handleChange}
      />
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={handleChange}
      />
    </div>
  );
}
