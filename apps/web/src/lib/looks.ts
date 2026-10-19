/**
 * Looks (`/polishes/looks`, `docs/looks-experience-plan.md`): pick a vibe, get three complete
 * nail looks built from the polishes you own, with the gaps you could buy to finish each one.
 *
 * Everything here is pure and seedable (like "Pick for me" in `pick-for-me.ts`): the vibe, the
 * polishes and the seed go in, the same looks come out. It runs client-side on the list the page
 * already fetches; there is no `/api/looks` endpoint yet.
 *
 * ## How a look is built
 *
 * 1. **Templates.** `LOOK_TEMPLATES` holds 18 named looks (Glazed Donut, Office Neutral, …). Each
 *    has target hexes per step (Base, Accent/Tip, optional Topper), the occasions/moods/finishes
 *    it suits, and a difficulty/time. `rankTemplatesForVibe` scores them: +3 occasion match, +3
 *    mood match, +2 finish match, plus a seeded jitter (`TEMPLATE_JITTER`) so Shuffle varies.
 * 2. **Base.** Owned polishes ranked by OKLAB distance to the template's base hex plus a finish
 *    penalty (`finishPenalty`: 0 when the polish has a preferred finish, then by the shared
 *    finish-family rule from `color/dupes.ts`). The vibe's finish preference overrides the base
 *    step's finishes (except Flake, which asks for a topper). A base's score (distance + finish
 *    penalty) must be within `BASE_MAX_DISTANCE`; among the near-ties (`BASE_TIE_BAND`) the seed picks one.
 * 3. **Accent.** Targets are the template's accent hex plus the harmony rotation of the chosen
 *    base (`generateHarmonyColors`: complementary, analogous or monochromatic). Candidates must
 *    be within `ACCENT_MAX_DISTANCE` of a target and at least `ACCENT_MIN_CONTRAST` from the
 *    base; among them, contrast with the base is rewarded ("maximize contrast within harmony").
 * 4. **Topper.** Owned topper/flake/glitter polishes (`TOPPER_FINISHES`, `topper` first), nearest
 *    the template's topper hex. No glitter-on-glitter: a look with a topper step never gets a
 *    glitter-family base (and a topper is skipped over one).
 * 5. **Gaps.** A step with no owned match is filled from the catalog pool (non-owned rows, same
 *    scoring, within `CATALOG_MAX_DISTANCE`) and otherwise left as the template swatch; both are
 *    "Add" steps. `catalogQueriesForLooks` tells the page which color families to fetch.
 *    Toppers and flakies are never a base or accent; a swap never offers a polish another step of
 *    the same look uses.
 * 6. **Diversity.** Looks are chosen greedily, one per round, from every remaining template,
 *    ranked by vibe score + jitter + `OWNED_BASE_BONUS` (owned base) + `OWNED_BONUS` × owned share.
 *    A base may not be any polish an earlier look used, and must be at
 *    least `LOOK_MIN_BASE_DISTANCE` from earlier bases unless both finish families are known and
 *    differ.
 * 7. **Owned only.** Every required step must be owned (optional toppers are dropped instead);
 *    templates that can't be built are skipped, and `shortfall` says fewer than three fit.
 */
import type {
  ColorFamily,
  LookFinish,
  LookMood,
  LookOccasion,
  LookStepRole,
  LookStepSource,
  LookVibe,
  ManicurePolishRole,
  Polish,
} from "swatchwatch-shared";
import { classifyHexColorFamily, finishCompatibility, finishFamily, resolveDisplayHex, resolvePolishFinishes } from "swatchwatch-shared";
import { colorDistance } from "./color-utils";
import { generateHarmonyColors } from "./color-harmonies";
import { isOwnedPolish } from "./inventory-status";
import { TOPPER_FINISHES, createSeededRandom, type RandomSource } from "./pick-for-me";

// ── Vibe ─────────────────────────────────────────────────────

// The vibe vocabulary is shared with the API (saved looks), so it lives in swatchwatch-shared.
export { LOOK_FINISHES, LOOK_MOODS, LOOK_OCCASIONS } from "swatchwatch-shared";
export type { LookFinish, LookMood, LookOccasion, LookStepRole, LookStepSource } from "swatchwatch-shared";

export const LOOK_OCCASION_LABELS: Record<LookOccasion, string> = {
  work: "Work",
  date: "Date",
  party: "Party",
  everyday: "Everyday",
  formal: "Formal",
};
export const LOOK_MOOD_LABELS: Record<LookMood, string> = {
  soft: "Soft",
  bold: "Bold",
  edgy: "Edgy",
  playful: "Playful",
};
export const LOOK_FINISH_LABELS: Record<LookFinish, string> = {
  gloss: "Gloss",
  matte: "Matte",
  chrome: "Chrome",
  holo: "Holo",
  flake: "Flake",
  sheer: "Sheer",
};

export type Vibe = LookVibe;

/** The vibe the page opens with (no "trending" data yet, so a safe everyday default). */
export const DEFAULT_VIBE: Vibe = { occasion: "everyday", mood: "soft", finish: null, ownedOnly: false };

/** Polish finish names each finish preference accepts (lowercase; `chrome` covers admin-added types). */
export const LOOK_FINISH_POLISH_FINISHES: Record<LookFinish, readonly string[]> = {
  gloss: ["creme", "crelly", "jelly"],
  matte: ["matte"],
  chrome: ["metallic", "chrome", "magnetic", "duochrome", "multichrome"],
  holo: ["holographic"],
  flake: ["flake", "glitter", "topper"],
  sheer: ["sheer", "jelly"],
};

// ── Templates ────────────────────────────────────────────────

export type LookDifficulty = "easy" | "medium" | "advanced";
/** How an accent relates to the chosen base: a harmony rotation of it, or the template hex only. */
export type LookAccentHarmony = "complementary" | "analogous" | "monochromatic" | "fixed";

export interface LookTemplateStep {
  role: LookStepRole;
  /** Display label, e.g. "Base", "Tip", "Accent nail", "Topper". */
  label: string;
  /** Target color (`#RRGGBB`, uppercase). */
  hex: string;
  /** Preferred polish finishes (lowercase); empty/omitted = any. */
  finishes?: readonly string[];
  /** Accent steps only (default `fixed`). */
  harmony?: LookAccentHarmony;
  /** Optional steps are dropped (not marked "Add") in owned-only mode. Toppers are always optional. */
  optional?: boolean;
}

export interface LookTemplate {
  id: string;
  name: string;
  description: string;
  occasions: readonly LookOccasion[];
  moods: readonly LookMood[];
  finishes: readonly LookFinish[];
  difficulty: LookDifficulty;
  /** Rough application time, minutes. */
  minutes: number;
  steps: readonly LookTemplateStep[];
}

const SOLID = ["creme", "crelly", "jelly"] as const;
const SHEER = ["sheer", "jelly"] as const;
// `metallic` first: finish compatibility compares against the first preferred finish, and `chrome` has no built-in family.
const CHROME = ["metallic", "chrome", "magnetic"] as const;
const SPARKLE = ["topper", "flake", "glitter"] as const;

/** Built-in looks: defaults for every vibe and the fallback when the collection is sparse. */
export const LOOK_TEMPLATES: readonly LookTemplate[] = [
  {
    id: "glazed-donut",
    name: "Glazed Donut",
    description: "Milky sheer base with a pearly chrome glaze.",
    occasions: ["everyday", "date", "formal"],
    moods: ["soft"],
    finishes: ["sheer", "chrome"],
    difficulty: "easy",
    minutes: 20,
    steps: [
      { role: "base", label: "Base", hex: "#F3E6E8", finishes: SHEER },
      { role: "topper", label: "Chrome glaze", hex: "#F5F0FF", finishes: ["topper", ...CHROME], optional: true },
    ],
  },
  {
    id: "office-neutral",
    name: "Office Neutral",
    description: "Polished nude with a tonal accent nail.",
    occasions: ["work", "everyday"],
    moods: ["soft"],
    finishes: ["gloss", "matte"],
    difficulty: "easy",
    minutes: 15,
    steps: [
      { role: "base", label: "Base", hex: "#D8BFAA", finishes: SOLID },
      { role: "accent", label: "Accent nail", hex: "#A8846A", harmony: "monochromatic", optional: true },
    ],
  },
  {
    id: "soft-chrome",
    name: "Soft Chrome",
    description: "Blush base buffed with a silvery chrome.",
    occasions: ["date", "party", "formal"],
    moods: ["soft", "edgy"],
    finishes: ["chrome"],
    difficulty: "medium",
    minutes: 25,
    steps: [
      { role: "base", label: "Base", hex: "#EBD3D6", finishes: SOLID },
      { role: "topper", label: "Chrome", hex: "#E3E3EC", finishes: [...CHROME, "topper"], optional: true },
    ],
  },
  {
    id: "galaxy-fade",
    name: "Galaxy Fade",
    description: "Midnight navy fading into violet, scattered with sparkle.",
    occasions: ["party"],
    moods: ["bold", "playful"],
    finishes: ["holo", "flake"],
    difficulty: "advanced",
    minutes: 40,
    steps: [
      { role: "base", label: "Base", hex: "#1B1F4B", finishes: SOLID },
      { role: "accent", label: "Fade", hex: "#5B2A86", harmony: "analogous" },
      { role: "topper", label: "Stardust", hex: "#C9C9FF", finishes: SPARKLE, optional: true },
    ],
  },
  {
    id: "cyber-violet",
    name: "Cyber Violet",
    description: "Electric violet with a neon cyan accent.",
    occasions: ["party"],
    moods: ["edgy", "bold"],
    finishes: ["chrome", "holo"],
    difficulty: "medium",
    minutes: 30,
    steps: [
      { role: "base", label: "Base", hex: "#7A2BE2", finishes: [...CHROME, ...SOLID] },
      { role: "accent", label: "Accent nail", hex: "#00C8E0", harmony: "complementary" },
    ],
  },
  {
    id: "berry-gradient",
    name: "Berry Gradient",
    description: "Deep berry melting into a brighter raspberry.",
    occasions: ["date", "formal", "everyday"],
    moods: ["bold"],
    finishes: ["gloss", "sheer"],
    difficulty: "medium",
    minutes: 30,
    steps: [
      { role: "base", label: "Base", hex: "#8B1E3F", finishes: SOLID },
      { role: "accent", label: "Gradient", hex: "#C2185B", harmony: "monochromatic" },
    ],
  },
  {
    id: "french-modern",
    name: "French Modern",
    description: "Sheer pink base with a crisp white tip.",
    occasions: ["work", "formal", "date", "everyday"],
    moods: ["soft"],
    finishes: ["gloss", "sheer"],
    difficulty: "medium",
    minutes: 25,
    steps: [
      { role: "base", label: "Base", hex: "#F2DCD5", finishes: SHEER },
      { role: "accent", label: "Tip", hex: "#FFFFFF", finishes: ["creme"], harmony: "fixed" },
    ],
  },
  {
    id: "monochrome-slick",
    name: "Monochrome Slick",
    description: "Glossy black with a charcoal accent.",
    occasions: ["formal", "party", "work"],
    moods: ["edgy"],
    finishes: ["gloss", "matte"],
    difficulty: "easy",
    minutes: 20,
    steps: [
      { role: "base", label: "Base", hex: "#111111", finishes: SOLID },
      { role: "accent", label: "Accent nail", hex: "#4A4A4A", harmony: "monochromatic" },
    ],
  },
  {
    id: "classic-red",
    name: "Classic Red",
    description: "True red with a gold accent.",
    occasions: ["date", "formal"],
    moods: ["bold"],
    finishes: ["gloss"],
    difficulty: "easy",
    minutes: 15,
    steps: [
      { role: "base", label: "Base", hex: "#B11226", finishes: SOLID },
      { role: "accent", label: "Accent nail", hex: "#D4AF37", finishes: CHROME, harmony: "fixed", optional: true },
    ],
  },
  {
    id: "milk-bath",
    name: "Milk Bath",
    description: "Milky white with floating pink flakes.",
    occasions: ["everyday", "work"],
    moods: ["soft", "playful"],
    finishes: ["sheer", "flake"],
    difficulty: "easy",
    minutes: 20,
    steps: [
      { role: "base", label: "Base", hex: "#F7EFE9", finishes: SHEER },
      { role: "topper", label: "Flakes", hex: "#F3C6D3", finishes: ["flake", "topper"], optional: true },
    ],
  },
  {
    id: "coral-pop",
    name: "Coral Pop",
    description: "Juicy coral with a tropical teal accent.",
    occasions: ["everyday", "party"],
    moods: ["playful", "bold"],
    finishes: ["gloss"],
    difficulty: "easy",
    minutes: 20,
    steps: [
      { role: "base", label: "Base", hex: "#FF6F61", finishes: SOLID },
      { role: "accent", label: "Accent nail", hex: "#2EC4B6", harmony: "complementary" },
    ],
  },
  {
    id: "matte-mauve",
    name: "Matte Mauve",
    description: "Velvety mauve with a soft rose accent.",
    occasions: ["work", "everyday"],
    moods: ["soft"],
    finishes: ["matte"],
    difficulty: "easy",
    minutes: 15,
    steps: [
      { role: "base", label: "Base", hex: "#9E7A8B", finishes: ["matte"] },
      { role: "accent", label: "Accent nail", hex: "#C9A9B5", harmony: "analogous", optional: true },
    ],
  },
  {
    id: "golden-hour",
    name: "Golden Hour",
    description: "Warm bronze with a gold-leaf accent.",
    occasions: ["date", "party"],
    moods: ["soft", "bold"],
    finishes: ["chrome"],
    difficulty: "medium",
    minutes: 25,
    steps: [
      { role: "base", label: "Base", hex: "#B07A4F", finishes: [...CHROME, "shimmer"] },
      { role: "accent", label: "Accent nail", hex: "#E8C27A", finishes: CHROME, harmony: "analogous" },
    ],
  },
  {
    id: "holo-dream",
    name: "Holo Dream",
    description: "Silvery holo with a lilac accent.",
    occasions: ["party", "date"],
    moods: ["playful"],
    finishes: ["holo"],
    difficulty: "medium",
    minutes: 25,
    steps: [
      { role: "base", label: "Base", hex: "#B8B8C8", finishes: ["holographic"] },
      { role: "accent", label: "Accent nail", hex: "#D9A8F0", harmony: "analogous" },
    ],
  },
  {
    id: "forest-velvet",
    name: "Forest Velvet",
    description: "Deep forest green with a gold accent.",
    occasions: ["formal", "date"],
    moods: ["edgy", "bold"],
    finishes: ["gloss", "matte"],
    difficulty: "medium",
    minutes: 25,
    steps: [
      { role: "base", label: "Base", hex: "#1E4D3A", finishes: SOLID },
      { role: "accent", label: "Accent nail", hex: "#C9A227", finishes: CHROME, harmony: "fixed" },
    ],
  },
  {
    id: "ocean-jelly",
    name: "Ocean Jelly",
    description: "See-through teal jelly with a deep blue accent.",
    occasions: ["everyday", "party"],
    moods: ["playful"],
    finishes: ["sheer", "gloss"],
    difficulty: "easy",
    minutes: 20,
    steps: [
      { role: "base", label: "Base", hex: "#3AA6B9", finishes: ["jelly", "sheer"] },
      { role: "accent", label: "Accent nail", hex: "#1F3A93", harmony: "analogous" },
    ],
  },
  {
    id: "pink-sparkle",
    name: "Pink Sparkle",
    description: "Sweet pink under a sparkly glitter topper.",
    occasions: ["party", "date", "everyday"],
    moods: ["playful", "soft"],
    finishes: ["flake"],
    difficulty: "easy",
    minutes: 20,
    steps: [
      { role: "base", label: "Base", hex: "#F4C2C2", finishes: SOLID },
      { role: "topper", label: "Glitter", hex: "#F8D7E8", finishes: SPARKLE, optional: true },
    ],
  },
  {
    id: "oxblood-matte",
    name: "Oxblood Matte",
    description: "Matte oxblood with a glossy black accent.",
    occasions: ["formal", "party", "date"],
    moods: ["edgy"],
    finishes: ["matte"],
    difficulty: "easy",
    minutes: 20,
    steps: [
      { role: "base", label: "Base", hex: "#4A0E1C", finishes: ["matte"] },
      { role: "accent", label: "Accent nail", hex: "#111111", finishes: SOLID, harmony: "fixed" },
    ],
  },
];

/** Topper step added to templates without one when the vibe asks for Flake. */
const FLAKE_TOPPER_STEP: LookTemplateStep = {
  role: "topper",
  label: "Topper",
  hex: "#E6E6FA",
  finishes: SPARKLE,
  optional: true,
};

// ── Tuning ───────────────────────────────────────────────────

export const LOOK_COUNT = 3;
/** Largest base score (OKLAB distance to the target + finish penalty) for an owned base. */
export const BASE_MAX_DISTANCE = 0.14;
/** Owned bases scoring within this of the best are near-ties; the seed picks among them. */
export const BASE_TIE_BAND = 0.03;
/** Largest OKLAB distance from an accent target (template hex or harmony rotation of the base). */
export const ACCENT_MAX_DISTANCE = 0.15;
/** An accent must differ from the base by at least this much (else it reads as the same color). */
export const ACCENT_MIN_CONTRAST = 0.08;
/** Weight of contrast-with-base in accent scoring (higher = bolder accents). */
export const ACCENT_CONTRAST_WEIGHT = 0.25;
/** Largest OKLAB distance from the target for a topper (toppers are mostly picked by finish). */
export const TOPPER_MAX_DISTANCE = 0.3;
/** Largest OKLAB distance from the target for a catalog gap fill. */
export const CATALOG_MAX_DISTANCE = 0.2;
/** Bases of two looks must be at least this far apart, unless their finish families differ. */
export const LOOK_MIN_BASE_DISTANCE = 0.1;
/** Most owned "Swap" alternatives offered per step. */
export const MAX_STEP_ALTERNATIVES = 3;
/** Rank bonus for a fully owned look (scaled by the owned share of its steps). */
export const OWNED_BONUS = 2;
/** Extra rank bonus when the base is owned, so an owned base beats the template jitter. */
export const OWNED_BASE_BONUS = 4;
/** Max seeded jitter added to a template's vibe score. */
export const TEMPLATE_JITTER = 2;

const VIBE_WEIGHTS = { occasion: 3, mood: 3, finish: 2 } as const;

// ── Results ──────────────────────────────────────────────────


export interface LookStep {
  role: LookStepRole;
  label: string;
  /** The template's target color for this step. */
  targetHex: string;
  /** The color to show: the polish's display hex, or the target when there is no polish. */
  hex: string;
  /** null when no polish matched (a template swatch to "Add"). */
  polish: Polish | null;
  source: LookStepSource;
  /** OKLAB distance from the polish to the step target (null without a polish). */
  distance: number | null;
  /** Next-best owned polishes for "Swap" (never the chosen one). */
  alternatives: Polish[];
}

export interface Look {
  templateId: string;
  name: string;
  description: string;
  difficulty: LookDifficulty;
  minutes: number;
  steps: LookStep[];
  ownedSteps: number;
  missingSteps: number;
}

export interface LooksResult {
  looks: Look[];
  /** Fewer than `LOOK_COUNT` looks could be built (owned-only with a sparse collection). */
  shortfall: boolean;
  /** Owned polishes considered. */
  ownedCount: number;
}

export interface RecommendLooksInput {
  /** The user's polishes; only `owned` ones are used as owned steps. */
  polishes: readonly Polish[];
  /** Catalog rows for gap fills (owned rows are ignored). */
  catalog?: readonly Polish[];
  vibe: Vibe;
  seed: number;
  /** Looks wanted (default `LOOK_COUNT`). */
  count?: number;
}

// ── Internals ────────────────────────────────────────────────

const HEX_RE = /^#[0-9A-Fa-f]{6}$/;

interface Candidate {
  polish: Polish;
  hex: string;
  finishes: string[];
  /** Family of the primary finish (undefined when unknown). */
  family: string | undefined;
}

function toCandidate(polish: Polish): Candidate | null {
  const hex = resolveDisplayHex(polish);
  if (!hex || !HEX_RE.test(hex)) return null;
  const finishes = resolvePolishFinishes(polish).map((f) => f.toLowerCase());
  return { polish, hex: hex.toUpperCase(), finishes, family: finishes[0] ? finishFamily(finishes[0]) : undefined };
}

/** 0 when the polish has a preferred finish; otherwise by the shared finish-compatibility rule. */
function finishPenalty(candidateFinishes: readonly string[], preferred: readonly string[] | undefined): number {
  if (!preferred || preferred.length === 0) return 0;
  if (candidateFinishes.some((f) => preferred.includes(f))) return 0;
  switch (finishCompatibility(preferred, candidateFinishes)) {
    case "same":
      return 0;
    case "compatible":
      return 0.02;
    case "unknown":
      return 0.04;
    default:
      return 0.08;
  }
}

function topperRank(candidate: Candidate): number {
  const index = TOPPER_FINISHES.findIndex((f) => candidate.finishes.includes(f));
  return index < 0 ? Number.POSITIVE_INFINITY : index;
}

function isTopperCandidate(candidate: Candidate): boolean {
  return Number.isFinite(topperRank(candidate));
}

/** Toppers and flakies only go on top; full-coverage glitters may still be a base or accent. */
function isTopOnly(candidate: Candidate): boolean {
  return candidate.finishes.includes("topper") || candidate.finishes.includes("flake");
}

interface Scored {
  candidate: Candidate;
  score: number;
  distance: number;
}

/** A chosen base, for the diversity rule. */
interface ChosenBase {
  id: string | null;
  hex: string;
  family: string | undefined;
}

function diverseFrom(hex: string, family: string | undefined, id: string | null, chosen: readonly ChosenBase[]): boolean {
  return chosen.every((base) => {
    if (id !== null && base.id === id) return false;
    if (colorDistance(hex, base.hex) >= LOOK_MIN_BASE_DISTANCE) return true;
    return Boolean(family && base.family && family !== base.family);
  });
}

function stepFinishes(step: LookTemplateStep, vibe: Vibe): readonly string[] | undefined {
  if (step.role === "base" && vibe.finish && vibe.finish !== "flake") return LOOK_FINISH_POLISH_FINISHES[vibe.finish];
  return step.finishes;
}

function templateSteps(template: LookTemplate, vibe: Vibe): readonly LookTemplateStep[] {
  if (vibe.finish === "flake" && !template.steps.some((s) => s.role === "topper")) {
    return [...template.steps, FLAKE_TOPPER_STEP];
  }
  return template.steps;
}

function scoreBase(c: Candidate, step: LookTemplateStep, vibe: Vibe): Scored {
  const distance = colorDistance(c.hex, step.hex);
  return { candidate: c, distance, score: distance + finishPenalty(c.finishes, stepFinishes(step, vibe)) };
}

function scoreAccent(c: Candidate, step: LookTemplateStep, targets: readonly string[], baseHex: string): Scored | null {
  const distance = Math.min(...targets.map((t) => colorDistance(c.hex, t)));
  if (distance > ACCENT_MAX_DISTANCE) return null;
  const contrast = colorDistance(c.hex, baseHex);
  if (contrast < ACCENT_MIN_CONTRAST) return null;
  return {
    candidate: c,
    distance,
    score: distance - ACCENT_CONTRAST_WEIGHT * Math.min(contrast, 0.4) + finishPenalty(c.finishes, step.finishes),
  };
}

function scoreTopper(c: Candidate, step: LookTemplateStep): Scored | null {
  if (!isTopperCandidate(c)) return null;
  const distance = colorDistance(c.hex, step.hex);
  if (distance > TOPPER_MAX_DISTANCE) return null;
  return { candidate: c, distance, score: topperRank(c) * 0.05 + distance * 0.5 + finishPenalty(c.finishes, step.finishes) };
}

function sortScored(list: Scored[]): Scored[] {
  return list.sort(
    (a, b) =>
      a.score - b.score ||
      a.candidate.polish.brand.localeCompare(b.candidate.polish.brand) ||
      a.candidate.polish.name.localeCompare(b.candidate.polish.name) ||
      a.candidate.polish.id.localeCompare(b.candidate.polish.id)
  );
}

function seededRandom(seed: number, salt: string): RandomSource {
  let hash = seed >>> 0;
  for (let i = 0; i < salt.length; i++) hash = Math.imul(hash ^ salt.charCodeAt(i), 0x01000193) >>> 0;
  return createSeededRandom(hash);
}

// ── Public API ───────────────────────────────────────────────

/** Vibe score of a template (no jitter): +3 occasion, +3 mood, +2 finish preference. */
export function vibeScore(template: LookTemplate, vibe: Vibe): number {
  return (
    (template.occasions.includes(vibe.occasion) ? VIBE_WEIGHTS.occasion : 0) +
    (template.moods.includes(vibe.mood) ? VIBE_WEIGHTS.mood : 0) +
    (vibe.finish && template.finishes.includes(vibe.finish) ? VIBE_WEIGHTS.finish : 0)
  );
}

/** Templates best-first for a vibe, with a seeded jitter so Shuffle changes the order. */
export function rankTemplatesForVibe(vibe: Vibe, seed: number): LookTemplate[] {
  const random = seededRandom(seed, "templates");
  return LOOK_TEMPLATES.map((template) => ({ template, score: vibeScore(template, vibe) + random() * TEMPLATE_JITTER }))
    .sort((a, b) => b.score - a.score || a.template.id.localeCompare(b.template.id))
    .map((entry) => entry.template);
}

interface BuildContext {
  vibe: Vibe;
  owned: Candidate[];
  catalog: Candidate[];
  chosenBases: ChosenBase[];
  /** Polishes used by earlier looks (any step); never a later look's base. */
  usedIds: Set<string>;
  seed: number;
}

function emptyStep(step: LookTemplateStep, alternatives: Polish[]): LookStep {
  return {
    role: step.role,
    label: step.label,
    targetHex: step.hex,
    hex: step.hex,
    polish: null,
    source: "template",
    distance: null,
    alternatives,
  };
}

function filledStep(step: LookTemplateStep, scored: Scored, source: LookStepSource, alternatives: Polish[]): LookStep {
  return {
    role: step.role,
    label: step.label,
    targetHex: step.hex,
    hex: scored.candidate.hex,
    polish: scored.candidate.polish,
    source,
    distance: Math.round(scored.distance * 10_000) / 10_000,
    alternatives,
  };
}

/** Build one look from a template, or null when it can't be built (owned-only, or no diverse base). */
function buildLook(template: LookTemplate, ctx: BuildContext): Look | null {
  const { vibe } = ctx;
  const steps = templateSteps(template, vibe);
  const baseStep = steps.find((s) => s.role === "base");
  if (!baseStep) return null;
  // No glitter-on-glitter: a look with a topper step never gets a glitter base.
  const hasTopper = steps.some((s) => s.role === "topper");
  const used = new Set<string>();
  const out: LookStep[] = [];

  // Base.
  const baseRanked = sortScored(
    ctx.owned
      .filter((c) => !isTopOnly(c) && !ctx.usedIds.has(c.polish.id) && !(hasTopper && c.family === "glitter"))
      .map((c) => scoreBase(c, baseStep, vibe))
      .filter((s) => s.score <= BASE_MAX_DISTANCE)
      .filter((s) => diverseFrom(s.candidate.hex, s.candidate.family, s.candidate.polish.id, ctx.chosenBases))
  );
  let baseHex: string;
  let baseFamily: string | undefined;
  if (baseRanked.length > 0) {
    const ties = baseRanked.filter((s) => s.score <= baseRanked[0].score + BASE_TIE_BAND);
    const pick = ties[Math.floor(seededRandom(ctx.seed, template.id)() * ties.length)];
    // Extra headroom: alternatives used by later steps are filtered out at the end.
    const alternatives = baseRanked.filter((s) => s !== pick).slice(0, MAX_STEP_ALTERNATIVES * 2).map((s) => s.candidate.polish);
    out.push(filledStep(baseStep, pick, "owned", alternatives));
    used.add(pick.candidate.polish.id);
    baseHex = pick.candidate.hex;
    baseFamily = pick.candidate.family;
  } else {
    if (vibe.ownedOnly) return null;
    const catalogPick = sortScored(
      ctx.catalog
        .filter((c) => !isTopOnly(c) && !(hasTopper && c.family === "glitter"))
        .map((c) => scoreBase(c, baseStep, vibe))
        .filter((s) => s.score <= CATALOG_MAX_DISTANCE)
        .filter((s) => diverseFrom(s.candidate.hex, s.candidate.family, s.candidate.polish.id, ctx.chosenBases))
    )[0];
    if (catalogPick) {
      out.push(filledStep(baseStep, catalogPick, "catalog", []));
      used.add(catalogPick.candidate.polish.id);
      baseHex = catalogPick.candidate.hex;
      baseFamily = catalogPick.candidate.family;
    } else {
      if (!diverseFrom(baseStep.hex, undefined, null, ctx.chosenBases)) return null;
      out.push(emptyStep(baseStep, []));
      baseHex = baseStep.hex;
      baseFamily = undefined;
    }
  }

  // Accents and topper, in template order.
  for (const step of steps) {
    if (step.role === "base") continue;
    if (step.role === "topper" && baseFamily === "glitter") continue;

    let rank: (c: Candidate) => Scored | null;
    if (step.role === "accent") {
      const harmony = step.harmony ?? "fixed";
      const targets = harmony === "fixed" ? [step.hex] : [step.hex, ...generateHarmonyColors(baseHex, harmony)];
      rank = (c) => (isTopOnly(c) ? null : scoreAccent(c, step, targets, baseHex));
    } else {
      rank = (c) => scoreTopper(c, step);
    }

    const ownedRanked = sortScored(
      ctx.owned.filter((c) => !used.has(c.polish.id)).flatMap((c) => rank(c) ?? [])
    );
    const pick = ownedRanked[0];
    if (pick) {
      const alternatives = ownedRanked.slice(1, 1 + MAX_STEP_ALTERNATIVES * 2).map((s) => s.candidate.polish);
      out.push(filledStep(step, pick, "owned", alternatives));
      used.add(pick.candidate.polish.id);
      continue;
    }
    const optional = step.optional || step.role === "topper";
    if (vibe.ownedOnly) {
      if (optional) continue;
      return null;
    }
    const catalogPick = sortScored(
      ctx.catalog
        .filter((c) => !used.has(c.polish.id))
        .flatMap((c) => {
          const scored = rank(c);
          return scored && scored.distance <= CATALOG_MAX_DISTANCE ? [scored] : [];
        })
    )[0];
    if (catalogPick) {
      out.push(filledStep(step, catalogPick, "catalog", []));
      used.add(catalogPick.candidate.polish.id);
    } else {
      out.push(emptyStep(step, []));
    }
  }

  // A swap never offers a polish another step of this look already uses.
  const finalSteps = out.map((step) => ({
    ...step,
    alternatives: step.alternatives.filter((alt) => !used.has(alt.id)).slice(0, MAX_STEP_ALTERNATIVES),
  }));
  const ownedSteps = finalSteps.filter((s) => s.source === "owned").length;
  return {
    templateId: template.id,
    name: template.name,
    description: template.description,
    difficulty: template.difficulty,
    minutes: template.minutes,
    steps: finalSteps,
    ownedSteps,
    missingSteps: finalSteps.length - ownedSteps,
  };
}

/**
 * Three (or `count`) diverse looks for a vibe. Pure: the same input gives the same looks.
 */
export function recommendLooks(input: RecommendLooksInput): LooksResult {
  const count = input.count ?? LOOK_COUNT;
  const owned = input.polishes.filter(isOwnedPolish).flatMap((p) => toCandidate(p) ?? []);
  const ownedIds = new Set(owned.map((c) => c.polish.id));
  const catalog = (input.catalog ?? [])
    .filter((p) => !isOwnedPolish(p) && !ownedIds.has(p.id))
    .flatMap((p) => toCandidate(p) ?? []);

  const random = seededRandom(input.seed, "templates");
  const jitter = new Map(LOOK_TEMPLATES.map((t) => [t.id, random() * TEMPLATE_JITTER]));

  const ctx: BuildContext = {
    vibe: input.vibe,
    owned,
    catalog,
    chosenBases: [],
    usedIds: new Set(),
    seed: input.seed,
  };
  const remaining = [...LOOK_TEMPLATES];
  const looks: Look[] = [];

  while (looks.length < count && remaining.length > 0) {
    let best: { look: Look; template: LookTemplate; rank: number } | null = null;
    for (const template of remaining) {
      const look = buildLook(template, ctx);
      if (!look) continue;
      const rank =
        vibeScore(template, input.vibe) +
        (jitter.get(template.id) ?? 0) +
        (look.steps[0].source === "owned" ? OWNED_BASE_BONUS : 0) +
        (OWNED_BONUS * look.ownedSteps) / look.steps.length;
      if (!best || rank > best.rank) best = { look, template, rank };
    }
    if (!best) break;
    looks.push(best.look);
    remaining.splice(remaining.indexOf(best.template), 1);
    for (const step of best.look.steps) if (step.polish) ctx.usedIds.add(step.polish.id);
    const base = best.look.steps.find((s) => s.role === "base")!;
    const baseFinishes = base.polish ? resolvePolishFinishes(base.polish).map((f) => f.toLowerCase()) : [];
    ctx.chosenBases.push({
      id: base.polish?.id ?? null,
      hex: base.hex,
      family: baseFinishes[0] ? finishFamily(baseFinishes[0]) : undefined,
    });
  }

  return { looks, shortfall: looks.length < count, ownedCount: owned.length };
}

/** Manicure role for a look step ("base" in a look is the color coat, not a base coat). */
export function maniRoleForStep(role: LookStepRole): ManicurePolishRole {
  return role === "base" ? "color" : role;
}

/** Owned steps of a look as mani-log entries ("Wear this"); steps to add are skipped. */
export function maniEntriesForLook(look: Pick<Look, "steps">): { shadeId: string; role: ManicurePolishRole }[] {
  return look.steps
    .filter((s) => s.source === "owned" && s.polish)
    .map((s) => ({ shadeId: s.polish!.id, role: maniRoleForStep(s.role) }));
}

export interface LookCatalogQueries {
  /** Color families of the color steps no owned polish filled (unique, first-seen order). */
  families: ColorFamily[];
  /** Whether any topper step needs a catalog topper. */
  toppers: boolean;
}

/** What to fetch from the catalog to fill the looks' gaps. */
export function catalogQueriesForLooks(looks: readonly Pick<Look, "steps">[]): LookCatalogQueries {
  const families: ColorFamily[] = [];
  let toppers = false;
  for (const step of looks.flatMap((l) => l.steps)) {
    if (step.source === "owned") continue;
    if (step.role === "topper") {
      toppers = true;
      continue;
    }
    const family = classifyHexColorFamily(step.targetHex);
    if (family && !families.includes(family)) families.push(family);
  }
  return { families, toppers };
}

/**
 * "Swap": replace a step's polish with one of its owned alternatives. The previous polish, when
 * owned, becomes the first alternative so the user can swap back. Returns a new look.
 */
export function applyStepSwap(look: Look, role: LookStepRole, polish: Polish): Look {
  const index = look.steps.findIndex((s) => s.role === role);
  if (index < 0) return look;
  const step = look.steps[index];
  const hex = resolveDisplayHex(polish);
  const previous = step.source === "owned" && step.polish ? [step.polish] : [];
  const alternatives = [...previous, ...step.alternatives.filter((a) => a.id !== polish.id)].slice(0, MAX_STEP_ALTERNATIVES);
  const nextStep: LookStep = {
    ...step,
    polish,
    source: "owned",
    hex: hex && HEX_RE.test(hex) ? hex.toUpperCase() : step.targetHex,
    distance: hex && HEX_RE.test(hex) ? Math.round(colorDistance(hex, step.targetHex) * 10_000) / 10_000 : null,
    alternatives,
  };
  const steps = look.steps.map((s, i) => (i === index ? nextStep : s));
  const ownedSteps = steps.filter((s) => s.source === "owned").length;
  return { ...look, steps, ownedSteps, missingSteps: steps.length - ownedSteps };
}
