import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import { renderTable } from "../hex/report";
import { OUTCOMES } from "./scoring";
import type { EvalSummary, Outcome, SampleResult } from "./types";

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

/** Plain-text report: outcome counts, rates, median time, resolver-audit stats, per brand and finish family (and per sample when verbose). */
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

  if (verbose && results.length > 0) {
    lines.push(
      "",
      renderTable(
        ["sample", "brand", "shade", "family", "catalog", "frames", "calls", "prompts", "card", "verdict", "outcome", "top", "candidates", "ms", "note"],
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
          r.topEntityId === null ? "-" : String(r.topEntityId),
          r.candidateIds.length ? r.candidateIds.join(",") : "-",
          String(r.ms),
          r.error ?? "",
        ])
      )
    );
  }
  return lines.join("\n");
}

/** Write `bottle-<ISO timestamp>.json` (`{ generatedAt, summary, results }`) into `dir`; returns its path. */
export function writeReportJson(dir: string, summary: EvalSummary, results: SampleResult[]): string {
  mkdirSync(dir, { recursive: true });
  const generatedAt = new Date().toISOString();
  const file = path.join(dir, `bottle-${generatedAt.replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, `${JSON.stringify({ generatedAt, summary, results }, null, 2)}\n`);
  return file;
}
