import type { BulkIngestionResponse } from "swatchwatch-shared";

/** Sources a bulk run left out because a job of theirs is still queued or running (#532). */
function skippedSentence(skipped: ReadonlyArray<{ source: string }>): string {
  return skipped.length > 0
    ? ` Skipped (a job is already queued or running): ${skipped.map((s) => s.source).join(", ")}.`
    : "";
}

/** Status line after `POST /api/ingestion/bulk` queued at least one job. */
export function bulkRunSuccessMessage(response: Pick<BulkIngestionResponse, "enqueued" | "skipped">): string {
  return `${response.enqueued} job${response.enqueued !== 1 ? "s" : ""} queued.` + skippedSentence(response.skipped ?? []);
}

/**
 * Error line for a failed bulk run. A 409 `source_busy` (every source already has a job queued or
 * running) shows the server's explanation and the busy sources; anything else keeps the error text.
 */
export function bulkRunErrorMessage(error: unknown): string {
  const body = (error as { body?: unknown } | null)?.body;
  if (body && typeof body === "object" && (body as { error?: unknown }).error === "source_busy") {
    const { message, skipped } = body as { message?: unknown; skipped?: unknown };
    const sources = Array.isArray(skipped)
      ? skipped.flatMap((s) =>
          s && typeof s === "object" && typeof (s as { source?: unknown }).source === "string"
            ? [{ source: (s as { source: string }).source }]
            : []
        )
      : [];
    const text = typeof message === "string" && message.trim() ? message.trim() : "Every selected source is busy.";
    return sources.length > 0 && !sources.every((s) => text.includes(s.source))
      ? `${text}${skippedSentence(sources)}`
      : text;
  }
  return error instanceof Error ? error.message : "Failed to queue bulk run";
}
