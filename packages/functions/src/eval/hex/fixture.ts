import { promises as fs } from "fs";
import path from "path";
import { normalizeHex } from "../../lib/color-match";
import type { EvalCase, EvalCaseImageRef, EvalFixture, GroundTruthSource } from "./types";

export const GROUND_TRUTH_SOURCES: readonly GroundTruthSource[] = [
  "vendor_option",
  "swatch_measured",
  "manual",
  "ai_detected",
];

export class FixtureValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FixtureValidationError";
  }
}

function fail(label: string, message: string): never {
  throw new FixtureValidationError(`${label}: ${message}`);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown, label: string, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    fail(label, `${field} must be an array of strings`);
  }
  return (value as string[]).map((entry) => entry.trim()).filter(Boolean);
}

function parseImages(value: unknown, label: string): EvalCaseImageRef[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail(label, "images must be an array");
  return value.map((entry, i) => {
    const at = `images[${i}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail(label, `${at} must be an object`);
    const row = entry as Record<string, unknown>;
    const url = optionalString(row.url);
    if (!url || !/^https?:\/\//i.test(url)) fail(label, `${at}.url must be an http(s) URL`);
    if (row.alt !== undefined && row.alt !== null && typeof row.alt !== "string") {
      fail(label, `${at}.alt must be a string`);
    }
    if (
      row.position !== undefined &&
      row.position !== null &&
      !(typeof row.position === "number" && Number.isInteger(row.position) && row.position > 0)
    ) {
      fail(label, `${at}.position must be a positive integer`);
    }
    const alt = typeof row.alt === "string" ? row.alt.replace(/\s+/g, " ").trim() : "";
    return {
      url,
      ...(alt ? { alt } : {}),
      ...(typeof row.position === "number" ? { position: row.position } : {}),
    };
  });
}

function parseCase(raw: unknown, index: number): EvalCase {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail(`cases[${index}]`, "must be an object");
  }
  const row = raw as Record<string, unknown>;
  const id = optionalString(row.id);
  const label = `cases[${index}]${id ? ` (${id})` : ""}`;
  if (!id) fail(label, "id is required");

  const brand = optionalString(row.brand);
  if (!brand) fail(label, "brand is required");
  const shadeName = optionalString(row.shadeName);
  if (!shadeName) fail(label, "shadeName is required");
  const source = optionalString(row.source);
  if (!source) fail(label, "source is required");

  const groundTruthHex = normalizeHex(optionalString(row.groundTruthHex));
  if (!groundTruthHex) fail(label, "groundTruthHex must be a 6-digit hex color");

  const groundTruthSource = optionalString(row.groundTruthSource) as GroundTruthSource | null;
  if (!groundTruthSource || !GROUND_TRUTH_SOURCES.includes(groundTruthSource)) {
    fail(label, `groundTruthSource must be one of ${GROUND_TRUTH_SOURCES.join(", ")}`);
  }

  const imageUrl = optionalString(row.imageUrl);
  const imagePath = optionalString(row.imagePath);
  if ((imageUrl ? 1 : 0) + (imagePath ? 1 : 0) !== 1) {
    fail(label, "exactly one of imageUrl or imagePath is required");
  }
  if (imageUrl && !/^https?:\/\//i.test(imageUrl)) {
    fail(label, "imageUrl must be an http(s) URL");
  }
  if (imagePath && (path.isAbsolute(imagePath) || imagePath.split(/[\\/]/).includes(".."))) {
    fail(label, "imagePath must be relative to the fixture directory and may not contain '..'");
  }

  const images = parseImages(row.images, label);

  return {
    id,
    brand,
    shadeName,
    finishes: stringArray(row.finishes, label, "finishes").map((finish) => finish.toLowerCase()),
    groundTruthHex,
    groundTruthSource,
    source,
    ...(imageUrl ? { imageUrl } : {}),
    ...(imagePath ? { imagePath } : {}),
    ...(images.length ? { images } : {}),
    description: optionalString(row.description),
    tags: stringArray(row.tags, label, "tags"),
    externalId: optionalString(row.externalId),
    notes: optionalString(row.notes),
  };
}

/** Validate a parsed fixture document. Throws `FixtureValidationError` with the offending case. */
export function parseFixture(doc: unknown, label = "fixture"): EvalFixture {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    fail(label, "must be a JSON object");
  }
  const row = doc as Record<string, unknown>;
  if (row.version !== 1) fail(label, "version must be 1");
  if (!Array.isArray(row.cases) || row.cases.length === 0) {
    fail(label, "cases must be a non-empty array");
  }

  const cases = row.cases.map((raw, index) => parseCase(raw, index));
  const seen = new Set<string>();
  for (const evalCase of cases) {
    if (seen.has(evalCase.id)) fail(label, `duplicate case id ${evalCase.id}`);
    seen.add(evalCase.id);
  }

  return {
    version: 1,
    ...(optionalString(row.description) ? { description: optionalString(row.description)! } : {}),
    cases,
  };
}

export interface LoadedFixture {
  fixture: EvalFixture;
  fixturePath: string;
  /** Directory `imagePath` entries resolve against. */
  fixtureDir: string;
}

export async function loadFixture(fixturePath: string): Promise<LoadedFixture> {
  const resolved = path.resolve(fixturePath);
  const text = await fs.readFile(resolved, "utf8");
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    throw new FixtureValidationError(
      `${resolved}: invalid JSON (${error instanceof Error ? error.message : String(error)})`
    );
  }
  return {
    fixture: parseFixture(doc, resolved),
    fixturePath: resolved,
    fixtureDir: path.dirname(resolved),
  };
}
