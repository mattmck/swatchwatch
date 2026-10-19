/**
 * Looks (`/polishes/looks`, `docs/looks-experience-plan.md`): the vibe vocabulary and saved looks.
 *
 * The recommender itself runs in the web app (`apps/web/src/lib/looks.ts`); what lives here is
 * what the API also needs: the vibe enums and the saved-look shape stored in `user_look`
 * (`GET/POST/DELETE /api/looks`). A saved look is an opaque display snapshot the client sends and
 * the API returns to its owner as-is (never joined to shades), validated by
 * `validateSavedLookInput` on both sides.
 */

export const LOOK_OCCASIONS = ["work", "date", "party", "everyday", "formal"] as const;
export const LOOK_MOODS = ["soft", "bold", "edgy", "playful"] as const;
export const LOOK_FINISHES = ["gloss", "matte", "chrome", "holo", "flake", "sheer"] as const;
export const LOOK_STEP_ROLES = ["base", "accent", "topper"] as const;
export const LOOK_STEP_SOURCES = ["owned", "catalog", "template"] as const;

export type LookOccasion = (typeof LOOK_OCCASIONS)[number];
export type LookMood = (typeof LOOK_MOODS)[number];
export type LookFinish = (typeof LOOK_FINISHES)[number];
export type LookStepRole = (typeof LOOK_STEP_ROLES)[number];
/** Where a step's polish comes from: your collection, the catalog (to buy), or just the template color. */
export type LookStepSource = (typeof LOOK_STEP_SOURCES)[number];

export interface LookVibe {
  occasion: LookOccasion;
  mood: LookMood;
  /** Finish preference; null = any finish. */
  finish: LookFinish | null;
  /** Only build looks entirely from owned polishes. */
  ownedOnly: boolean;
}

/** Most saved looks kept per user (oldest fall off). */
export const MAX_SAVED_LOOKS = 30;
/** Most steps in a look (Base, Accent, Topper, plus one spare). */
export const MAX_LOOK_STEPS = 4;

export interface SavedLookStep {
  role: LookStepRole;
  label: string;
  /** `#RRGGBB`, uppercase. */
  hex: string;
  source: LookStepSource;
  /** Shade id of the step's polish (absent for template-only steps). */
  shadeId?: string;
  brand?: string;
  name?: string;
}

/** What the client sends to save a look (`POST /api/looks`). */
export interface SavedLookInput {
  /** Look key, `savedLookKey(templateId, steps)`: the same combo is saved once. */
  id: string;
  templateId: string;
  name: string;
  vibe: LookVibe;
  steps: SavedLookStep[];
}

export interface SavedLook extends SavedLookInput {
  /** ISO timestamp of the (latest) save. */
  savedAt: string;
}

/** `GET /api/looks`: the caller's saved looks, newest first. */
export interface SavedLookListResponse {
  looks: SavedLook[];
}

/** `<templateId>:<shadeId or "-" per step>`, e.g. `office-neutral:12,-`. */
export function savedLookKey(templateId: string, steps: readonly Pick<SavedLookStep, "shadeId">[]): string {
  return `${templateId}:${steps.map((s) => s.shadeId ?? "-").join(",")}`;
}

const LIMITS = { label: 40, name: 80, brand: 120, shadeName: 160 } as const;
const TEMPLATE_ID_RE = /^[a-z0-9-]{1,40}$/;
const HEX_RE = /^#[0-9A-Fa-f]{6}$/;
const SHADE_ID_RE = /^[1-9]\d{0,17}$/;

export type SavedLookValidation = { ok: true; look: SavedLookInput } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= max ? trimmed : null;
}

function validateStep(raw: unknown, index: number): SavedLookStep | string {
  if (!isRecord(raw)) return `steps[${index}] must be an object`;
  if (!oneOf(LOOK_STEP_ROLES, raw.role)) return `steps[${index}].role is invalid`;
  if (!oneOf(LOOK_STEP_SOURCES, raw.source)) return `steps[${index}].source is invalid`;
  const label = boundedText(raw.label, LIMITS.label);
  if (!label) return `steps[${index}].label must be 1–${LIMITS.label} characters`;
  if (typeof raw.hex !== "string" || !HEX_RE.test(raw.hex)) return `steps[${index}].hex must be #RRGGBB`;
  const step: SavedLookStep = { role: raw.role, label, hex: raw.hex.toUpperCase(), source: raw.source };
  if (raw.shadeId !== undefined) {
    if (typeof raw.shadeId !== "string" || !SHADE_ID_RE.test(raw.shadeId)) return `steps[${index}].shadeId is invalid`;
    step.shadeId = raw.shadeId;
  }
  if (raw.brand !== undefined) {
    const brand = boundedText(raw.brand, LIMITS.brand);
    if (!brand) return `steps[${index}].brand must be 1–${LIMITS.brand} characters`;
    step.brand = brand;
  }
  if (raw.name !== undefined) {
    const name = boundedText(raw.name, LIMITS.shadeName);
    if (!name) return `steps[${index}].name must be 1–${LIMITS.shadeName} characters`;
    step.name = name;
  }
  return step;
}

function validateVibe(raw: unknown): LookVibe | null {
  if (!isRecord(raw)) return null;
  if (!oneOf(LOOK_OCCASIONS, raw.occasion) || !oneOf(LOOK_MOODS, raw.mood)) return null;
  if (raw.finish !== null && !oneOf(LOOK_FINISHES, raw.finish)) return null;
  if (typeof raw.ownedOnly !== "boolean") return null;
  return { occasion: raw.occasion, mood: raw.mood, finish: raw.finish, ownedOnly: raw.ownedOnly };
}

/**
 * Validate and normalize a saved look (API request body or a stored copy). Unknown fields are
 * dropped, hexes are uppercased, text is trimmed and length-capped, and `id` must equal
 * `savedLookKey(templateId, steps)`.
 */
export function validateSavedLookInput(input: unknown): SavedLookValidation {
  if (!isRecord(input)) return { ok: false, error: "Body must be a JSON object" };
  if (typeof input.templateId !== "string" || !TEMPLATE_ID_RE.test(input.templateId)) {
    return { ok: false, error: "templateId is invalid" };
  }
  const name = boundedText(input.name, LIMITS.name);
  if (!name) return { ok: false, error: `name must be 1–${LIMITS.name} characters` };
  const vibe = validateVibe(input.vibe);
  if (!vibe) return { ok: false, error: "vibe is invalid" };
  if (!Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > MAX_LOOK_STEPS) {
    return { ok: false, error: `steps must have 1–${MAX_LOOK_STEPS} entries` };
  }
  const steps: SavedLookStep[] = [];
  for (let i = 0; i < input.steps.length; i++) {
    const step = validateStep(input.steps[i], i);
    if (typeof step === "string") return { ok: false, error: step };
    steps.push(step);
  }
  const id = savedLookKey(input.templateId, steps);
  if (input.id !== id) return { ok: false, error: "id must be the look key of templateId and steps" };
  return { ok: true, look: { id, templateId: input.templateId, name, vibe, steps } };
}
