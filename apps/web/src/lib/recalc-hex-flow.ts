import type { Polish, PolishFinish } from "swatchwatch-shared";
import type { RecalcPolishHexResponse } from "./api";

type ToastOptions = { description?: string };

export interface RecalcToastApi {
  success: (message: string, options?: ToastOptions) => void;
  info: (message: string, options?: ToastOptions) => void;
  error: (message: string, options?: ToastOptions) => void;
}

export interface RunRecalcHexFlowInput {
  polishId: string;
  recalc: (polishId: string) => Promise<RecalcPolishHexResponse>;
  knownFinishes: readonly string[];
  setPendingById: (
    updater: (prev: Record<string, boolean>) => Record<string, boolean>
  ) => void;
  setPolishes: (updater: (prev: Polish[]) => Polish[]) => void;
  toast: RecalcToastApi;
}

function confidenceText(confidence?: number | null): string | undefined {
  return typeof confidence === "number"
    ? `${Math.round(confidence * 100)}% confidence`
    : undefined;
}

function finishesText(finishes?: PolishFinish[] | null): string | undefined {
  return finishes?.length ? `Finishes: ${finishes.join(", ")}` : undefined;
}

function firstSuggestedFinish(
  finishes: PolishFinish[] | null | undefined,
  knownFinishes: readonly string[]
): Polish["finish"] | undefined {
  const suggested = finishes?.find((finish) => knownFinishes.includes(finish));
  return suggested as Polish["finish"] | undefined;
}

function withRecalcResult(
  polish: Polish,
  polishId: string,
  result: RecalcPolishHexResponse,
  knownFinishes: readonly string[]
): Polish {
  if (polish.id !== polishId || !result.detectedHex) {
    return polish;
  }

  const detectedHex = result.detectedHex ?? undefined;
  const suggestedFinish = firstSuggestedFinish(result.finishes, knownFinishes);
  const hasExistingFinish =
    typeof polish.finish === "string" && polish.finish.trim().length > 0;

  return {
    ...polish,
    detectedHex,
    finish: hasExistingFinish ? polish.finish : suggestedFinish,
  };
}

export async function runRecalcHexFlow(input: RunRecalcHexFlowInput): Promise<void> {
  const { polishId, recalc, knownFinishes, setPendingById, setPolishes, toast } = input;

  setPendingById((prev) => ({ ...prev, [polishId]: true }));

  try {
    const result = await recalc(polishId);

    setPolishes((prev) =>
      prev.map((polish) => withRecalcResult(polish, polishId, result, knownFinishes))
    );

    const description = [confidenceText(result.confidence), finishesText(result.finishes)]
      .filter(Boolean)
      .join(" · ");

    if (result.detectedHex) {
      toast.success(result.message ?? `Detected hex ${result.detectedHex}`, {
        description: description || undefined,
      });
    } else {
      toast.info(result.message ?? "Could not detect hex from image", {
        description: confidenceText(result.confidence),
      });
    }
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Failed to recalculate shade hex.";
    toast.error("Hex recalculation failed", { description: message });
  } finally {
    setPendingById((prev) => {
      const next = { ...prev };
      delete next[polishId];
      return next;
    });
  }
}
