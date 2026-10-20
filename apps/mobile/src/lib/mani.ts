/**
 * Pure helpers for the mani log (#269): the "Log a mani" sheet's entries and date, request
 * building and display formatting. The wear-stat rules live on the server (the mani log
 * recomputes `wearCount` / `lastWornAt` after every write); the client only builds requests.
 */
import {
  DEFAULT_MANICURE_POLISH_ROLE,
  MANICURE_POLISH_ROLES,
  MAX_MANICURE_NOTES_LENGTH,
  MAX_MANICURE_POLISHES,
  resolvePolishFinishes,
  resolveDisplayHex,
  type ManicureCreateRequest,
  type ManicurePolish,
  type ManicurePolishRole,
  type Polish,
} from "swatchwatch-shared";
import { localIsoDate } from "./status";

export interface ManiEntry {
  shadeId: string;
  role: ManicurePolishRole;
  brand: string;
  name: string;
  hex?: string;
}

export const ROLE_LABELS: Record<ManicurePolishRole, string> = {
  base: "Base",
  color: "Color",
  accent: "Accent",
  topper: "Topper",
  other: "Other",
};

/** Toppers default to the topper role, everything else to color (web: `defaultRoleFor`). */
export function defaultRoleFor(polish: Pick<Polish, "finish" | "finishes">): ManicurePolishRole {
  return resolvePolishFinishes(polish).some((f) => f.toLowerCase() === "topper") ? "topper" : DEFAULT_MANICURE_POLISH_ROLE;
}

export function entryFromPolish(polish: Polish, role: ManicurePolishRole = defaultRoleFor(polish)): ManiEntry {
  return { shadeId: polish.id, role, brand: polish.brand, name: polish.name, hex: resolveDisplayHex(polish) };
}

export function entryFromManicurePolish(polish: ManicurePolish): ManiEntry {
  return {
    shadeId: polish.shadeId,
    role: polish.role,
    brand: polish.brand,
    name: polish.name,
    hex: polish.vendorHex ?? polish.detectedHex ?? polish.nameHex ?? undefined,
  };
}

/** Add an entry unless the same polish already has that role, or the cap is reached. */
export function addEntry(entries: readonly ManiEntry[], entry: ManiEntry): ManiEntry[] {
  if (entries.length >= MAX_MANICURE_POLISHES) return [...entries];
  if (entries.some((e) => e.shadeId === entry.shadeId && e.role === entry.role)) return [...entries];
  return [...entries, entry];
}

export function removeEntry(entries: readonly ManiEntry[], index: number): ManiEntry[] {
  return entries.filter((_, i) => i !== index);
}

/** Next role in display order, skipping one that would duplicate (same polish, same role). */
export function cycleRole(entries: readonly ManiEntry[], index: number): ManiEntry[] {
  const current = entries[index];
  if (!current) return [...entries];
  const start = MANICURE_POLISH_ROLES.indexOf(current.role);
  for (let step = 1; step <= MANICURE_POLISH_ROLES.length; step += 1) {
    const role = MANICURE_POLISH_ROLES[(start + step) % MANICURE_POLISH_ROLES.length];
    if (!entries.some((e, i) => i !== index && e.shadeId === current.shadeId && e.role === role)) {
      return entries.map((e, i) => (i === index ? { ...e, role } : e));
    }
  }
  return [...entries];
}

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date `YYYY-MM-DD` that is not after `today`. */
export function isValidWornOn(value: string, today: string = localIsoDate()): boolean {
  if (!YMD_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return false;
  return value <= today;
}

/** `value` shifted by `days` calendar days (`YYYY-MM-DD`), or `value` when it isn't a date. */
export function shiftDate(value: string, days: number): string {
  if (!YMD_RE.test(value)) return value;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Validation message for the sheet's form, or null when it can be saved. */
export function validateManiForm(input: { entries: readonly ManiEntry[]; wornOn: string; notes: string }, today: string = localIsoDate()): string | null {
  if (input.entries.length === 0) return "Add at least one polish.";
  if (!isValidWornOn(input.wornOn, today)) return "Use a date like 2026-10-18, no later than today.";
  if (input.notes.length > MAX_MANICURE_NOTES_LENGTH) return `Notes can be at most ${MAX_MANICURE_NOTES_LENGTH} characters.`;
  return null;
}

export function buildManiRequest(input: { entries: readonly ManiEntry[]; wornOn: string; notes: string }): ManicureCreateRequest {
  const notes = input.notes.trim();
  return {
    wornOn: input.wornOn,
    notes: notes || null,
    polishes: input.entries.slice(0, MAX_MANICURE_POLISHES).map((e) => ({ shadeId: e.shadeId, role: e.role })),
  };
}

/** "Today", "Yesterday", or "Sat, Oct 17" for a `YYYY-MM-DD` date. */
export function formatWornOn(value: string, today: string = localIsoDate()): string {
  if (value === today) return "Today";
  if (value === shiftDate(today, -1)) return "Yesterday";
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}
