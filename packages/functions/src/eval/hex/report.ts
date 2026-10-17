import { promises as fs } from "fs";
import path from "path";
import type { EvalReport, ScoreSummary } from "./types";

function fmtDistance(value: number | null): string {
  return value === null ? "-" : value.toFixed(4);
}

function fmtShare(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

function summaryRow(label: string, summary: ScoreSummary): string[] {
  return [
    label,
    String(summary.count),
    String(summary.scored),
    fmtDistance(summary.medianDistance),
    fmtDistance(summary.p90Distance),
    fmtShare(summary.withinHigh),
    fmtShare(summary.withinMedium),
  ];
}

/** Render rows as a padded plain-text table. */
export function renderTable(header: string[], rows: string[][]): string {
  const widths = header.map((cell, column) =>
    Math.max(cell.length, ...rows.map((row) => (row[column] ?? "").length))
  );
  const line = (cells: string[]) =>
    cells.map((cell, column) => (column === 0 ? cell.padEnd(widths[column]) : cell.padStart(widths[column]))).join("  ");
  return [line(header), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(line)].join("\n");
}

/** Human-readable report: overall, per brand, per primary finish (and per case when verbose). */
export function formatReport(report: EvalReport, options?: { verbose?: boolean }): string {
  const { thresholds } = report;
  const header = ["group", "n", "scored", "median", "p90", `<=${thresholds.high}`, `<=${thresholds.medium}`];
  const rows: string[][] = [summaryRow("overall", report.overall)];
  for (const [brand, summary] of Object.entries(report.byBrand)) {
    rows.push(summaryRow(`brand: ${brand}`, summary));
  }
  for (const [finish, summary] of Object.entries(report.byFinish)) {
    rows.push(summaryRow(`finish: ${finish}`, summary));
  }

  const lines = [
    `Strategy: ${report.strategy}`,
    `Fixture:  ${report.fixture}`,
    `Cases:    ${report.overall.count} (${report.overall.missing} without a prediction)`,
    "OKLAB distance to ground truth (lower is better); shares count missing predictions as outside the threshold.",
    "",
    renderTable(header, rows),
  ];

  if (options?.verbose) {
    const caseHeader = ["case", "finish", "truth", "predicted", "distance", "bucket", "note"];
    const caseRows = report.cases.map((score) => [
      score.caseId,
      score.primaryFinish,
      score.groundTruthHex,
      score.predictedHex ?? "-",
      fmtDistance(score.distance),
      score.bucket,
      score.error ?? "",
    ]);
    lines.push("", renderTable(caseHeader, caseRows));
  }

  return lines.join("\n");
}

function timestampSlug(iso: string): string {
  return iso.replace(/[:.]/g, "-");
}

/** Write `<strategy>-<timestamp>.json` and refresh `<strategy>-latest.json`; returns the timestamped path. */
export async function writeReportJson(report: EvalReport, resultsDir: string): Promise<string> {
  await fs.mkdir(resultsDir, { recursive: true });
  const json = JSON.stringify(report, null, 2);
  const stamped = path.join(resultsDir, `${report.strategy}-${timestampSlug(report.generatedAt)}.json`);
  await fs.writeFile(stamped, json);
  await fs.writeFile(path.join(resultsDir, `${report.strategy}-latest.json`), json);
  return stamped;
}
