/**
 * Step-tagged failures of `uploadSourceImageToBlob` (lib/blob-storage). Kept out of blob-storage
 * so ingestion code (and tests that stub blob-storage) can describe a failure without it.
 */
import { describeFetchError } from "./fetch-retry";

/** Step of `uploadSourceImageToBlob` that failed (variant writes never fail the upload). */
export type SourceImageUploadStep = "source_download" | "image_processing" | "blob_put";

const SOURCE_IMAGE_UPLOAD_STEP_LABELS: Record<SourceImageUploadStep, string> = {
  source_download: "source download",
  image_processing: "image processing",
  blob_put: "blob PUT",
};

/**
 * Failure of one step of `uploadSourceImageToBlob`, naming the step and the host it talked to so
 * an ingestion log line no longer blames the vendor image URL for a storage error. The original
 * error is kept as `cause`, and `message` keeps undici's hidden cause (`describeFetchError`).
 */
export class SourceImageUploadError extends Error {
  constructor(
    public readonly step: SourceImageUploadStep,
    public readonly host: string | null,
    cause: unknown
  ) {
    super(
      `${SOURCE_IMAGE_UPLOAD_STEP_LABELS[step]}${host ? ` (${host})` : ""} failed: ${describeFetchError(cause)}`,
      { cause }
    );
    this.name = "SourceImageUploadError";
  }

  get stepLabel(): string {
    return SOURCE_IMAGE_UPLOAD_STEP_LABELS[this.step];
  }
}

/** Log fields for a failed image store: the step, the host it talked to and the underlying error. */
export function describeImageStoreFailure(error: unknown): {
  step: SourceImageUploadStep | "unknown";
  stepLabel: string;
  host: string | null;
  error: string;
} {
  if (error instanceof SourceImageUploadError) {
    return { step: error.step, stepLabel: error.stepLabel, host: error.host, error: describeFetchError(error.cause) };
  }
  return { step: "unknown", stepLabel: "image store", host: null, error: describeFetchError(error) };
}
