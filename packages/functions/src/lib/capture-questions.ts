import { CaptureMatchCandidate, CaptureQuestionSpec } from "./capture-evidence";

/**
 * `capture_question.options_json` parameter. node-pg sends a JS array as a Postgres array
 * literal (`{"a","b"}`), which `::jsonb` rejects, so serialize it as JSON text.
 */
export function serializeQuestionOptions(options: string[] | undefined): string | null {
  return options ? JSON.stringify(options) : null;
}

export function buildNeedsFrameQuestion(): CaptureQuestionSpec {
  return {
    key: "capture_frame",
    prompt: "Upload at least one barcode or label frame so we can continue matching.",
    type: "single_select",
    options: ["scan_barcode", "upload_label_photo", "skip"],
  };
}

export function buildBrandShadeQuestion(): CaptureQuestionSpec {
  return {
    key: "brand_shade",
    prompt: "Tell us the brand and shade name (or upload a clearer label frame) to improve matching.",
    type: "free_text",
    options: ["brand + shade", "upload_label_photo", "skip"],
  };
}

export function buildCandidateQuestion(candidates: CaptureMatchCandidate[]): CaptureQuestionSpec {
  return {
    key: "candidate_select",
    prompt: "We found close shade matches. Reply with a shade ID from the options below, or skip.",
    type: "single_select",
    options: [
      ...candidates.map((candidate) => `${candidate.entityId}: ${candidate.display}`),
      "skip",
    ],
  };
}
