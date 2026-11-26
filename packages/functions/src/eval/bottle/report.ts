import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import { renderTable } from "../hex/report";
import { FAILURE_STAGES, OUTCOMES } from "./scoring";
import type { EvalSummary, FailureStage, Outcome, SampleResult } from "./types";

const SHORT: Record<Outcome, string> = {
  matched_correct: "match ok",
  matched_wrong: "match wrong",
  asked_has_correct: "ask ok",
  asked_no_correct: "ask wrong",
  unmatched: "unmatched",
  rejected_correct: "reject ok",
  skipped_no_frames: "no frames",
  error: "error",
};

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * Plain-text report: outcome counts, rates, median time, resolver-audit stats, per brand and finish
 * family, failure stages (total and per brand, only stages that occurred), and per sample when
 * verbose (with the stage, and its detail in the note column).
 */
export function formatSummary(summary: EvalSummary, results: SampleResult[], verbose: boolean): string {
  const catalog = results.filter((r) => r.inCatalog).length;
  const lines = [
    `Samples: ${summary.samples} (${catalog} in catalog, ${summary.samples - catalog} not in catalog)`,
    "",
    renderTable(
      ["outcome", "n"],
      OUTCOMES.map((outcome) => [outcome, String(summary.byOutcome[outcome])])
    ),
    "",
    `Match rate:      ${pct(summary.matchRate)}  (matched_correct / scored catalog samples)`,
    `Ask rate:        ${pct(summary.askRate)}  (asked_* / scored catalog samples)`,
    `False confident: ${summary.falseConfident}  (matched_wrong)`,
    `Median time:     ${Math.round(summary.medianMs)} ms per bottle`,
    `Model calls per bottle: mean ${summary.modelCalls.mean.toFixed(2)} / median ${summary.modelCalls.median} (${summary.modelCalls.samples} bottle(s) reported)`,
    `Median frames needed:   ${summary.medianFramesNeeded}`,
    `Create card (not in catalog): ${pct(summary.createCardRate)}  (suggestedShade / scored not-in-catalog samples)`,
  ];

  const brands = Object.keys(summary.byBrand).sort((a, b) => a.localeCompare(b));
  if (brands.length > 0) {
    lines.push(
      "",
      renderTable(
        ["brand", "n", ...OUTCOMES.map((o) => SHORT[o])],
        brands.map((brand) => {
          const counts = summary.byBrand[brand];
          const total = OUTCOMES.reduce((sum, o) => sum + counts[o], 0);
          return [brand, String(total), ...OUTCOMES.map((o) => String(counts[o]))];
        })
      )
    );
  }

  const families = Object.keys(summary.byFinishFamily).sort((a, b) => a.localeCompare(b));
  if (families.length > 0) {
    lines.push(
      "",
      renderTable(
        ["finish family", "n", ...OUTCOMES.map((o) => SHORT[o])],
        families.map((family) => {
          const counts = summary.byFinishFamily[family];
          const total = OUTCOMES.reduce((sum, o) => sum + counts[o], 0);
          return [family, String(total), ...OUTCOMES.map((o) => String(counts[o]))];
        })
      )
    );
  }

  const stages = FAILURE_STAGES.filter((stage) => summary.byFailureStage[stage] > 0);
  if (stages.length > 0) {
    const total = stages.reduce((sum, stage) => sum + summary.byFailureStage[stage], 0);
    lines.push(
      "",
      `Failure stages (earliest stage that lost each sample; ${total} sample(s)):`,
      renderTable(
        ["stage", "n"],
        stages.map((stage) => [stage, String(summary.byFailureStage[stage])])
      )
    );
    const stageBrands = Object.keys(summary.byBrandFailureStage).sort((a, b) => a.localeCompare(b));
    if (stageBrands.length > 0) {
      lines.push(
        "",
        renderTable(
          ["brand", ...stages],
          stageBrands.map((brand) => {
            const counts: Record<FailureStage, number> = summary.byBrandFailureStage[brand];
            return [brand, ...stages.map((stage) => String(counts[stage]))];
          })
        )
      );
    }
  }

  if (verbose && results.length > 0) {
    lines.push(
      "",
      renderTable(
        ["sample", "brand", "shade", "family", "catalog", "frames", "calls", "prompts", "card", "verdict", "outcome", "stage", "top", "candidates", "ms", "note"],
        results.map((r) => [
          String(r.sampleId),
          r.brand,
          r.shadeName,
          r.finishFamily,
          r.inCatalog ? "yes" : "no",
          String(r.frames),
          r.modelCalls === null ? "-" : String(r.modelCalls),
          r.adaptive ? String(r.promptsFollowed) : "-",
          r.createCard ? "yes" : "no",
          r.status,
          r.outcome,
          r.failureStage ?? "-",
          r.topEntityId === null ? "-" : String(r.topEntityId),
          r.candidateIds.length ? r.candidateIds.join(",") : "-",
          String(r.ms),
          r.error ?? r.failureDetail ?? "",
        ])
      )
    );
  }
  return lines.join("\n");
}

/** Write `bottle-<ISO timestamp>.json` (`{ generatedAt, summary, results }`) into `dir`; returns its path. */
export function writeReportJson(
  dir: string,
  summary: EvalSummary,
  results: SampleResult[],
  meta: { aiReplayMode?: string } = {}
): string {
  mkdirSync(dir, { recursive: true });
  const generatedAt = new Date().toISOString();
  const file = path.join(dir, `bottle-${generatedAt.replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, `${JSON.stringify({ generatedAt, ...meta, summary, results }, null, 2)}\n`);
  return file;
}
