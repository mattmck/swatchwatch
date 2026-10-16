/**
 * Identifies hex values that are likely vendor placeholders or defaults
 * rather than actual product colors.
 *
 * When `detectHexOnSuspiciousOnly` is enabled, AI image detection will
 * only run for products whose vendor hex is flagged as suspicious.
 *
 * Two layers:
 *
 * 1. `isSuspiciousHex(hex)` — the original context-free check against a small
 *    hardcoded set of pure black/white/gray/primary values. Kept as-is for
 *    callers that look at one hex in isolation (eval harness populate, etc.).
 *
 * 2. `buildSuspiciousHexContext(vendorHexes)` + `isSuspiciousHexInContext(...)`
 *    — a data-driven check for one data source's record batch. On top of the
 *    static set it flags:
 *      - template defaults: a hex shared by many records in the batch (a store
 *        theme default like `#C8A2C8` repeated across 40 shades);
 *      - near-grayscale hexes (low OKLAB chroma) unless the shade name or tags
 *        say the polish really is gray/silver/black/white/nude/chrome;
 *      - exact web-named palette colors (`#FF69B4` hot pink, `#4169E1` royal
 *        blue, …) when the shade name is not that color word — a vendor that
 *        writes `#FF69B4` for "Midnight Garden" copied a CSS palette.
 */

import { hexToOklab } from "swatchwatch-shared";
import { COMMON_COLORS } from "./connectors/color-name-detection";

const SUSPICIOUS_HEXES = new Set([
  // Pure black/white
  "#000000",
  "#FFFFFF",

  // Common gray defaults
  "#808080",
  "#C0C0C0",
  "#D3D3D3",
  "#A9A9A9",
  "#DCDCDC",
  "#F5F5F5",
  "#E0E0E0",
  "#BEBEBE",

  // Gray scale steps often used as placeholders
  "#111111",
  "#222222",
  "#333333",
  "#444444",
  "#555555",
  "#666666",
  "#777777",
  "#888888",
  "#999999",
  "#AAAAAA",
  "#BBBBBB",
  "#CCCCCC",
  "#DDDDDD",
  "#EEEEEE",
  "#F0F0F0",

  // Pure primary colors (unlikely to be real polish colors)
  "#FF0000",
  "#00FF00",
  "#0000FF",

  // Pure secondary colors
  "#FFFF00",
  "#FF00FF",
  "#00FFFF",
]);

/**
 * Returns true if the hex value looks like a vendor placeholder/default
 * rather than a real product color.
 *
 * Null/undefined/empty values are always considered suspicious.
 */
export function isSuspiciousHex(hex: string | null | undefined): boolean {
  const normalized = hex?.trim().toUpperCase();
  if (!normalized) {
    return true;
  }

  if (!normalized.startsWith("#")) {
    return SUSPICIOUS_HEXES.has(`#${normalized}`);
  }

  return SUSPICIOUS_HEXES.has(normalized);
}

// ---------------------------------------------------------------------------
// Contextual (batch-aware) detection
// ---------------------------------------------------------------------------

/** Default: a hex must appear on at least this many records to count as a template default. */
export const DEFAULT_SUSPICIOUS_HEX_REPEAT_MIN_RECORDS = 3;
/** Default: ...and on at least this share (0–1) of the records that carry a vendor hex. */
export const DEFAULT_SUSPICIOUS_HEX_REPEAT_MIN_SHARE = 0.1;
/**
 * Default: OKLAB chroma (sqrt(a² + b²)) below which a hex is treated as near-grayscale.
 * Pure grays are 0; a muted nude like #D4A574 is ≈0.08, a dusty mauve ≈0.04, and
 * "almost gray with a hint of blue" placeholders like #E8EAF0 are ≈0.01.
 */
export const DEFAULT_SUSPICIOUS_HEX_GRAYSCALE_MAX_CHROMA = 0.02;

export interface SuspiciousHexThresholds {
  /** Minimum record count sharing a hex before it is a template default. */
  repeatMinRecords: number;
  /** Minimum share (0–1) of hex-bearing records sharing a hex before it is a template default. */
  repeatMinShare: number;
  /** OKLAB chroma below which a hex counts as near-grayscale. */
  grayscaleMaxChroma: number;
}

export interface SuspiciousHexContext {
  /** Records in the batch that carried a parseable vendor hex. */
  hexRecordCount: number;
  /** Occurrences per normalized hex (`#RRGGBB`). */
  counts: ReadonlyMap<string, number>;
  /** Hexes that crossed the repeat thresholds. */
  templateDefaults: ReadonlySet<string>;
  thresholds: SuspiciousHexThresholds;
}

export interface SuspiciousHexHints {
  /** Shade / product name, used to excuse grays and web-named colors. */
  shadeName?: string | null;
  /** Vendor tags (e.g. `color:silver`, `finish:chrome`). */
  tags?: readonly string[] | null;
}

export type SuspiciousHexReason =
  | "missing"
  | "malformed"
  | "placeholder"
  | "template-default"
  | "near-grayscale"
  | "web-palette";

export interface SuspiciousHexVerdict {
  suspicious: boolean;
  reason: SuspiciousHexReason | null;
  /** Human-readable explanation for job logs. */
  detail: string | null;
}

const HEX6 = /^#?([0-9A-F]{6})$/;

/** Normalize to `#RRGGBB` (uppercase) or null when not a 6-digit hex. */
export function normalizeHex6(hex: string | null | undefined): string | null {
  const trimmed = hex?.trim().toUpperCase();
  if (!trimmed) return null;
  const match = trimmed.match(HEX6);
  return match ? `#${match[1]}` : null;
}

function readNumberEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/**
 * Thresholds from the environment (`SUSPICIOUS_HEX_REPEAT_MIN_RECORDS`,
 * `SUSPICIOUS_HEX_REPEAT_MIN_SHARE`, `SUSPICIOUS_HEX_GRAYSCALE_MAX_CHROMA`),
 * falling back to the defaults. Explicit overrides win over env.
 */
export function resolveSuspiciousHexThresholds(
  overrides?: Partial<SuspiciousHexThresholds>
): SuspiciousHexThresholds {
  return {
    repeatMinRecords:
      overrides?.repeatMinRecords ??
      readNumberEnv("SUSPICIOUS_HEX_REPEAT_MIN_RECORDS", DEFAULT_SUSPICIOUS_HEX_REPEAT_MIN_RECORDS, 1, 1_000_000),
    repeatMinShare:
      overrides?.repeatMinShare ??
      readNumberEnv("SUSPICIOUS_HEX_REPEAT_MIN_SHARE", DEFAULT_SUSPICIOUS_HEX_REPEAT_MIN_SHARE, 0, 1),
    grayscaleMaxChroma:
      overrides?.grayscaleMaxChroma ??
      readNumberEnv("SUSPICIOUS_HEX_GRAYSCALE_MAX_CHROMA", DEFAULT_SUSPICIOUS_HEX_GRAYSCALE_MAX_CHROMA, 0, 1),
  };
}

/**
 * Build the batch context for one data source: count how often each vendor hex
 * repeats and mark the ones that look like a store template default.
 *
 * A hex is a template default when it appears on at least `repeatMinRecords`
 * records AND on at least `repeatMinShare` of the records that have a vendor
 * hex at all (defaults: 3 records and 10%).
 */
export function buildSuspiciousHexContext(
  vendorHexes: ReadonlyArray<string | null | undefined>,
  thresholdOverrides?: Partial<SuspiciousHexThresholds>
): SuspiciousHexContext {
  const thresholds = resolveSuspiciousHexThresholds(thresholdOverrides);
  const counts = new Map<string, number>();
  let hexRecordCount = 0;

  for (const raw of vendorHexes) {
    const hex = normalizeHex6(raw);
    if (!hex) continue;
    hexRecordCount += 1;
    counts.set(hex, (counts.get(hex) ?? 0) + 1);
  }

  const templateDefaults = new Set<string>();
  if (hexRecordCount > 0) {
    for (const [hex, count] of counts) {
      if (count >= thresholds.repeatMinRecords && count / hexRecordCount >= thresholds.repeatMinShare) {
        templateDefaults.add(hex);
      }
    }
  }

  return { hexRecordCount, counts, templateDefaults, thresholds };
}

/** Words in a shade name or tags that make a near-grayscale hex plausible. */
const GRAYSCALE_NAME_HINTS = [
  "gray",
  "grey",
  "greige",
  "silver",
  "black",
  "white",
  "nude",
  "chrome",
  "charcoal",
  "slate",
  "graphite",
  "gunmetal",
  "pewter",
  "platinum",
  "steel",
  "smoke",
  "smoky",
  "ash",
  "onyx",
  "noir",
  "ebony",
  "ivory",
  "cream",
  "snow",
  "pearl",
  "taupe",
  "mushroom",
  "stone",
  "concrete",
  "cement",
  "mirror",
  "metallic",
  "shadow",
  "midnight",
  "ink",
  "jet",
  "bone",
  "linen",
  "milk",
  "milky",
  "coconut",
  "oyster",
  "mist",
  "fog",
  "storm",
  "cloud",
];

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
  );
}

function hintTokens(hints?: SuspiciousHexHints): Set<string> {
  const parts: string[] = [];
  if (hints?.shadeName) parts.push(hints.shadeName);
  for (const tag of hints?.tags ?? []) {
    if (typeof tag === "string") parts.push(tag);
  }
  return tokenize(parts.join(" "));
}

function hasAnyToken(tokens: Set<string>, words: readonly string[]): boolean {
  return words.some((word) => tokens.has(word));
}

/** OKLAB chroma of a `#RRGGBB` hex. */
export function hexChroma(hex: string): number {
  const { a, b } = hexToOklab(hex);
  return Math.sqrt(a * a + b * b);
}

/** Reverse index of the builtin web palette: `#RRGGBB` → color names that map to it. */
const WEB_PALETTE_NAMES: ReadonlyMap<string, string[]> = (() => {
  const map = new Map<string, string[]>();
  for (const [name, hex] of Object.entries(COMMON_COLORS)) {
    const key = normalizeHex6(hex);
    if (!key) continue;
    const list = map.get(key) ?? [];
    list.push(name.toLowerCase());
    map.set(key, list);
  }
  return map;
})();

/**
 * True when the shade name/tags mention the web color word(s) that map to this
 * hex — either the full phrase ("hot pink") or its base color word ("pink").
 */
function nameMatchesWebColor(hex: string, tokens: Set<string>, haystack: string): boolean {
  const names = WEB_PALETTE_NAMES.get(hex);
  if (!names) return false;
  for (const name of names) {
    if (haystack.includes(name)) return true;
    const words = name.split(/\s+/);
    const base = words[words.length - 1];
    if (base && tokens.has(base)) return true;
  }
  return false;
}

/**
 * Explain whether a vendor hex is suspicious given the batch context and the
 * record's own name/tags. `reason` is null when the hex looks trustworthy.
 */
export function classifySuspiciousHex(
  hex: string | null | undefined,
  context: SuspiciousHexContext,
  hints?: SuspiciousHexHints
): SuspiciousHexVerdict {
  const trimmed = hex?.trim();
  if (!trimmed) {
    return { suspicious: true, reason: "missing", detail: "no vendor hex" };
  }

  const normalized = normalizeHex6(trimmed);
  if (!normalized) {
    return { suspicious: true, reason: "malformed", detail: `vendor hex "${trimmed}" is not #RRGGBB` };
  }

  if (SUSPICIOUS_HEXES.has(normalized)) {
    return { suspicious: true, reason: "placeholder", detail: `${normalized} is a known placeholder value` };
  }

  if (context.templateDefaults.has(normalized)) {
    const count = context.counts.get(normalized) ?? 0;
    const share = context.hexRecordCount ? Math.round((count / context.hexRecordCount) * 100) : 0;
    return {
      suspicious: true,
      reason: "template-default",
      detail: `${normalized} repeats on ${count}/${context.hexRecordCount} records (${share}%) — likely a store template default`,
    };
  }

  const tokens = hintTokens(hints);
  const haystack = [hints?.shadeName ?? "", ...(hints?.tags ?? [])].join(" ").toLowerCase();

  const chroma = hexChroma(normalized);
  if (chroma < context.thresholds.grayscaleMaxChroma && !hasAnyToken(tokens, GRAYSCALE_NAME_HINTS)) {
    return {
      suspicious: true,
      reason: "near-grayscale",
      detail: `${normalized} is near-grayscale (OKLAB chroma ${chroma.toFixed(3)}) and the name/tags do not suggest a gray, silver, black, white, nude or chrome shade`,
    };
  }

  if (WEB_PALETTE_NAMES.has(normalized) && !nameMatchesWebColor(normalized, tokens, haystack)) {
    const names = WEB_PALETTE_NAMES.get(normalized) ?? [];
    return {
      suspicious: true,
      reason: "web-palette",
      detail: `${normalized} is the web color "${names[0]}" but the shade name does not say so — likely copied from a CSS palette`,
    };
  }

  return { suspicious: false, reason: null, detail: null };
}

/**
 * Batch-aware replacement for `isSuspiciousHex`: true when the hex is missing,
 * malformed, a known placeholder, a template default repeated across the batch,
 * near-grayscale without a gray-ish name, or an exact web-palette color whose
 * name the shade does not carry.
 */
export function isSuspiciousHexInContext(
  hex: string | null | undefined,
  context: SuspiciousHexContext,
  hints?: SuspiciousHexHints
): boolean {
  return classifySuspiciousHex(hex, context, hints).suspicious;
}
