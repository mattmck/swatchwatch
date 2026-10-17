import type {
  Manicure,
  ManicureCreateRequest,
  ManicurePolish,
  ManicurePolishRole,
  Polish,
} from "swatchwatch-shared";
import {
  MANICURE_POLISH_ROLES,
  MAX_MANICURE_NOTES_LENGTH,
  MAX_MANICURE_POLISHES,
  resolveDisplayHex,
  resolvePolishFinishes,
} from "swatchwatch-shared";

/** Display labels for manicure polish roles (issue #269). */
export const MANICURE_ROLE_LABELS: Record<ManicurePolishRole, string> = {
  base: "Base",
  color: "Color",
  accent: "Accent",
  topper: "Topper",
  other: "Other",
};

export const MANICURE_ROLE_OPTIONS: ManicurePolishRole[] = [...MANICURE_POLISH_ROLES];

/** Weeks shown in the `/manis` calendar strip (current week included). */
export const CALENDAR_STRIP_WEEKS = 6;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` of `date` in the browser's local timezone (what "today" means to the user). */
export function toLocalIsoDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Calendar arithmetic on `YYYY-MM-DD` strings (UTC-based, so DST never skips a day). */
export function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Monday of the week containing `isoDate`. */
export function startOfWeek(isoDate: string): string {
  const weekday = new Date(`${isoDate}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(isoDate, -((weekday + 6) % 7));
}

/** Date range the calendar strip covers: Monday `weeks - 1` weeks back through Sunday of this week. */
export function calendarStripRange(todayIso: string, weeks: number = CALENDAR_STRIP_WEEKS): { from: string; to: string } {
  const from = addDays(startOfWeek(todayIso), -7 * (weeks - 1));
  return { from, to: addDays(from, 7 * weeks - 1) };
}

export interface CalendarDay {
  date: string;
  isToday: boolean;
  isFuture: boolean;
  manicures: Manicure[];
  /** Display hexes of the day's polishes (color/accent first), for the day's swatch dots. */
  hexes: string[];
}

/** Weeks (oldest first) of seven days (Monday → Sunday) with the manicures worn on each day. */
export function buildCalendarStrip(
  manicures: Manicure[],
  todayIso: string,
  weeks: number = CALENDAR_STRIP_WEEKS
): CalendarDay[][] {
  const byDate = new Map<string, Manicure[]>();
  for (const manicure of manicures) {
    const list = byDate.get(manicure.wornOn) ?? [];
    list.push(manicure);
    byDate.set(manicure.wornOn, list);
  }
  const { from } = calendarStripRange(todayIso, weeks);
  return Array.from({ length: weeks }, (_, week) =>
    Array.from({ length: 7 }, (_, day) => {
      const date = addDays(from, week * 7 + day);
      const dayManicures = byDate.get(date) ?? [];
      return {
        date,
        isToday: date === todayIso,
        isFuture: date > todayIso,
        manicures: dayManicures,
        hexes: Array.from(new Set(dayManicures.flatMap(manicureHexes))),
      };
    })
  );
}

const ROLE_DISPLAY_ORDER: Record<ManicurePolishRole, number> = {
  color: 0,
  accent: 1,
  topper: 2,
  other: 3,
  base: 4,
};

/** Display hex of a manicure polish (vendor > detected > name, like `resolveDisplayHex`). */
export function manicurePolishHex(polish: Pick<ManicurePolish, "vendorHex" | "detectedHex" | "nameHex">): string | undefined {
  return polish.vendorHex || polish.detectedHex || polish.nameHex || undefined;
}

/** Display hexes of a manicure's polishes, color/accent first, base coats last. */
export function manicureHexes(manicure: Pick<Manicure, "polishes">): string[] {
  return [...manicure.polishes]
    .sort((a, b) => ROLE_DISPLAY_ORDER[a.role] - ROLE_DISPLAY_ORDER[b.role] || a.position - b.position)
    .map(manicurePolishHex)
    .filter((hex): hex is string => typeof hex === "string" && hex.length > 0);
}

/** "Today", "Yesterday", or e.g. "Mon, Oct 12" (with the year when it differs from today's). */
export function formatWornOn(isoDate: string, todayIso: string): string {
  if (isoDate === todayIso) return "Today";
  if (isoDate === addDays(todayIso, -1)) return "Yesterday";
  const date = new Date(`${isoDate}T00:00:00Z`);
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: isoDate.slice(0, 4) === todayIso.slice(0, 4) ? undefined : "numeric",
    timeZone: "UTC",
  });
}

/** One polish picked in the "Log a mani" form. */
export interface ManiFormEntry {
  shadeId: string;
  role: ManicurePolishRole;
  brand: string;
  name: string;
  hex?: string;
}

/** Role a polish gets when first picked: toppers as `topper`, everything else as `color`. */
export function defaultRoleFor(polish: Pick<Polish, "finish" | "finishes">): ManicurePolishRole {
  return resolvePolishFinishes(polish).some((finish) => finish.toLowerCase() === "topper") ? "topper" : "color";
}

export function entryFromPolish(polish: Polish, role: ManicurePolishRole = defaultRoleFor(polish)): ManiFormEntry {
  return { shadeId: polish.id, role, brand: polish.brand, name: polish.name, hex: resolveDisplayHex(polish) };
}

export function entryFromManicurePolish(polish: ManicurePolish): ManiFormEntry {
  return {
    shadeId: polish.shadeId,
    role: polish.role,
    brand: polish.brand,
    name: polish.name,
    hex: manicurePolishHex(polish),
  };
}

/** Polishes offered by the picker: the collection (owned + destash), brand then name. */
export function pickablePolishes(polishes: Polish[]): Polish[] {
  return polishes
    .filter((polish) => polish.status === "owned" || polish.status === "destash")
    .sort((a, b) => a.brand.localeCompare(b.brand) || a.name.localeCompare(b.name));
}

/** Case-insensitive match on brand + name (every whitespace-separated term must match). */
export function filterPickable(polishes: Polish[], search: string): Polish[] {
  const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return polishes;
  return polishes.filter((polish) => {
    const haystack = `${polish.brand} ${polish.name}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

export interface ManiFormValues {
  wornOn: string;
  entries: ManiFormEntry[];
  notes: string;
}

/** Client-side check mirroring the API rules; returns an error message or null. */
export function validateManiForm(values: ManiFormValues, todayIso: string): string | null {
  if (!ISO_DATE_RE.test(values.wornOn)) return "Pick the date you wore it.";
  if (values.wornOn > addDays(todayIso, 1)) return "The date can't be in the future.";
  if (values.entries.length === 0) return "Pick at least one polish.";
  if (values.entries.length > MAX_MANICURE_POLISHES) return `A mani can have at most ${MAX_MANICURE_POLISHES} polishes.`;
  const seen = new Set<string>();
  for (const entry of values.entries) {
    const key = `${entry.shadeId}:${entry.role}`;
    if (seen.has(key)) return `${entry.brand} ${entry.name} is listed twice as ${MANICURE_ROLE_LABELS[entry.role]}.`;
    seen.add(key);
  }
  if (values.notes.trim().length > MAX_MANICURE_NOTES_LENGTH) {
    return `Notes can be at most ${MAX_MANICURE_NOTES_LENGTH} characters.`;
  }
  return null;
}

/** Request body for create (and update: the polish list is replaced, notes cleared when blank). */
export function buildManicureRequest(values: ManiFormValues): ManicureCreateRequest {
  const notes = values.notes.trim();
  return {
    wornOn: values.wornOn,
    notes: notes.length > 0 ? notes : null,
    polishes: values.entries.map((entry) => ({ shadeId: entry.shadeId, role: entry.role })),
  };
}

/** An extra polish logged alongside the main one (e.g. a "Pick for me" pairing). */
export interface QuickLogCompanion {
  id: string;
  role: ManicurePolishRole;
}

/**
 * One-tap "Log today's mani" body for a polish, plus optional companions (pairings) in order.
 * Duplicate `shadeId:role` pairs are dropped, and the list is capped at `MAX_MANICURE_POLISHES`.
 */
export function quickLogRequest(
  polish: Pick<Polish, "id" | "finish" | "finishes">,
  todayIso: string,
  companions: readonly QuickLogCompanion[] = []
): ManicureCreateRequest {
  const seen = new Set<string>();
  const polishes: ManicureCreateRequest["polishes"] = [];
  for (const entry of [{ id: polish.id, role: defaultRoleFor(polish) }, ...companions]) {
    const key = `${entry.id}:${entry.role}`;
    if (seen.has(key)) continue;
    seen.add(key);
    polishes.push({ shadeId: entry.id, role: entry.role });
  }
  return { wornOn: todayIso, polishes: polishes.slice(0, MAX_MANICURE_POLISHES) };
}

/** Polishes can be logged only when the caller has an inventory row for them. */
export function canLogPolish(polish: Pick<Polish, "status">): boolean {
  return Boolean(polish.status);
}
