/**
 * Rapid Add shelf mode (#21 follow-up): a running list of this session's verdicts, so a shopper
 * can check a shelf of bottles one after another and act on them afterwards.
 *
 * Every finished scan becomes a `ShelfEntry` (newest first). A second scan of the same barcode
 * is flagged in place ("Scanned already") instead of appended. Entries hold only ids, names,
 * hexes and verdicts — never frame or image data — and live in `sessionStorage` per user
 * (`shelfStorageKey`), cleared by Clear shelf and on sign-out (`clearAllShelves`).
 *
 * Nothing here adds to the collection: the page calls the API when the user taps an action and
 * then records it with `acted`.
 */
import type { PolishDupeHint } from "swatchwatch-shared";
import type { CaptureVerdict } from "./capture-verdict";

/** The chip a shelf entry shows. */
export type ShelfVerdict = "owned" | "wishlist" | "near_dupe" | "new" | "not_found";

/** What the user did with an entry from Rapid Add (the verdict card or the shelf). */
export type ShelfActed = "added" | "wishlisted" | "bought_another";

export interface ShelfDupe {
  /** `high` = close dupe, `medium` = near dupe (the dupe finder grades). */
  grade: "high" | "medium";
  /** "Brand Shade" of the best owned dupe. */
  name: string;
}

export interface ShelfEntry {
  /** Stable key: `gtin:<code>` for barcode scans, `capture:<id>` otherwise. */
  key: string;
  captureId: string | null;
  gtin?: string;
  format?: string;
  shadeId?: string;
  display?: string;
  hex?: string;
  verdict: ShelfVerdict;
  /** Bottles owned when known (owned entries, and after Add / "I bought another"). */
  quantity?: number;
  dupe?: ShelfDupe;
  /** Set once the user acted on it; the entry shows the new state. */
  acted?: ShelfActed;
  /** Brand/shade learned by a label scan, for the manual add link of a not-found entry. */
  brand?: string;
  shadeName?: string;
  firstScannedAt: number;
  lastScannedAt: number;
  scanCount: number;
}

export interface ShelfState {
  entries: ShelfEntry[];
  /** Key of the entry the latest scan matched an earlier one (for the "Scanned already" flag). */
  repeatKey: string | null;
  /** Entry the scan in progress made; its later verdicts update it (`verdict`), until `scan_ended`. */
  currentKey: string | null;
}

export const EMPTY_SHELF: ShelfState = { entries: [], repeatKey: null, currentKey: null };

/** The most entries kept; the oldest drop off beyond it. */
export const SHELF_MAX_ENTRIES = 100;

export const SHELF_STORAGE_PREFIX = "swatchwatch.rapid-add.shelf";

/** Per-user sessionStorage key; without a user id, one shared key (cleared on sign-out too). */
export function shelfStorageKey(userId: string | null | undefined): string {
  return userId ? `${SHELF_STORAGE_PREFIX}:${userId}` : SHELF_STORAGE_PREFIX;
}

export function shelfEntryKey(input: { gtin?: string; captureId?: string | null }): string | null {
  if (input.gtin) return `gtin:${input.gtin}`;
  if (input.captureId) return `capture:${input.captureId}`;
  return null;
}

/**
 * The shelf entry for a verdict, or null when there is nothing to key it by (no barcode and no
 * capture session). Finalize-based verdicts (`owned` / `added`) already changed the collection,
 * so they arrive acted on.
 */
export function shelfEntryFromVerdict(
  verdict: CaptureVerdict,
  context: { captureId: string | null; now: number; quantityRestored?: boolean },
): ShelfEntry | null {
  const base = { captureId: context.captureId, firstScannedAt: context.now, lastScannedAt: context.now, scanCount: 1 };
  switch (verdict.kind) {
    case "checked": {
      const key = shelfEntryKey({ gtin: verdict.gtin || undefined, captureId: context.captureId });
      if (!key) return null;
      const entry: ShelfEntry = {
        ...base,
        key,
        verdict:
          verdict.relationship === "owned" ? "owned" : verdict.relationship === "wishlisted" ? "wishlist" : "new",
        display: verdict.display,
      };
      if (verdict.gtin) entry.gtin = verdict.gtin;
      if (verdict.shadeId) entry.shadeId = verdict.shadeId;
      if (verdict.hex) entry.hex = verdict.hex;
      if (typeof verdict.quantity === "number") entry.quantity = verdict.quantity;
      if (verdict.wishlistedNow) entry.acted = "wishlisted";
      return entry;
    }
    case "near_dupe": {
      const key = shelfEntryKey({ gtin: verdict.gtin || undefined, captureId: context.captureId });
      if (!key) return null;
      const entry: ShelfEntry = {
        ...base,
        key,
        verdict: "near_dupe",
        display: verdict.display,
        shadeId: verdict.shadeId,
      };
      if (verdict.gtin) entry.gtin = verdict.gtin;
      if (verdict.hex) entry.hex = verdict.hex;
      const dupe = shelfDupeFromHint({
        shadeId: verdict.shadeId,
        best: verdict.dupes.dupes[0] ?? null,
        dupeCount: verdict.dupes.dupeCount,
        highCount: verdict.dupes.highCount,
      });
      if (dupe) entry.dupe = dupe;
      return entry;
    }
    case "unknown_barcode": {
      const entry: ShelfEntry = { ...base, key: `gtin:${verdict.gtin}`, gtin: verdict.gtin, verdict: "not_found" };
      if (verdict.format) entry.format = verdict.format;
      return entry;
    }
    case "owned": {
      const key = shelfEntryKey({ captureId: context.captureId });
      if (!key) return null;
      const entry: ShelfEntry = {
        ...base,
        key,
        verdict: "owned",
        display: verdict.display,
        quantity: context.quantityRestored ? verdict.previousQuantity : verdict.quantity,
      };
      if (!context.quantityRestored) entry.acted = "bought_another";
      if (verdict.shadeId) entry.shadeId = verdict.shadeId;
      if (verdict.hex) entry.hex = verdict.hex;
      return entry;
    }
    case "added": {
      const key = shelfEntryKey({ captureId: context.captureId });
      if (!key) return null;
      const entry: ShelfEntry = { ...base, key, verdict: "new", display: verdict.display, acted: "added", quantity: 1 };
      if (verdict.shadeId) entry.shadeId = verdict.shadeId;
      return entry;
    }
    case "add": {
      const key = shelfEntryKey({ gtin: verdict.evidence.gtin, captureId: context.captureId });
      if (!key) return null;
      const entry: ShelfEntry = { ...base, key, verdict: "not_found" };
      if (verdict.display) entry.display = verdict.display;
      if (verdict.evidence.gtin) entry.gtin = verdict.evidence.gtin;
      if (verdict.evidence.brand) entry.brand = verdict.evidence.brand;
      if (verdict.evidence.shadeName) entry.shadeName = verdict.evidence.shadeName;
      return entry;
    }
    default:
      return null;
  }
}

/** Near-dupe info from a dupe-finder hint; null when nothing owned grades HIGH/MEDIUM. */
export function shelfDupeFromHint(hint: PolishDupeHint | null | undefined): ShelfDupe | null {
  const best = hint?.best;
  if (!best) return null;
  return { grade: best.grade === "high" ? "high" : "medium", name: [best.brand, best.name].filter(Boolean).join(" ") };
}

/** Whether a dupe check is worth making for an entry: a catalog shade the user doesn't own. */
export function shelfNeedsDupeCheck(entry: Pick<ShelfEntry, "verdict" | "shadeId" | "acted">): boolean {
  return Boolean(entry.shadeId) && entry.verdict === "new" && !entry.acted;
}

export type ShelfAction =
  /** A verdict of the scan in progress: updates its entry, or adds one for its first verdict. */
  | { type: "verdict"; entry: ShelfEntry; clearActed?: boolean }
  /** "Scan next": the next verdict starts a new entry. */
  | { type: "scan_ended" }
  | { type: "scanned"; entry: ShelfEntry }
  /**
   * A later verdict of the same scan (the card's Add / ♡ / undo, or a label photo after an
   * unknown barcode) updates the entry the scan made, whatever key the new verdict would get.
   */
  | { type: "verdict_updated"; key: string; entry: ShelfEntry; clearActed?: boolean }
  | { type: "acted"; key: string; acted: ShelfActed | undefined; quantity?: number }
  | { type: "dupe_resolved"; key: string; dupe: ShelfDupe | null }
  | { type: "hydrated"; entries: ShelfEntry[] }
  | { type: "cleared" };

function replaceEntry(state: ShelfState, key: string, update: (entry: ShelfEntry) => ShelfEntry): ShelfState {
  const index = state.entries.findIndex((entry) => entry.key === key);
  if (index < 0) return state;
  const entries = state.entries.slice();
  entries[index] = update(entries[index]);
  return { ...state, entries };
}

/** Whether a `verdict` dispatch would start a new entry (rather than update the current one). */
export function shelfStartsEntry(state: ShelfState): boolean {
  return !state.currentKey || !state.entries.some((entry) => entry.key === state.currentKey);
}

export function shelfReducer(state: ShelfState, action: ShelfAction): ShelfState {
  switch (action.type) {
    case "verdict": {
      if (!shelfStartsEntry(state)) {
        return shelfReducer(state, {
          type: "verdict_updated",
          key: state.currentKey as string,
          entry: action.entry,
          clearActed: action.clearActed,
        });
      }
      return { ...shelfReducer(state, { type: "scanned", entry: action.entry }), currentKey: action.entry.key };
    }
    case "scan_ended":
      return state.currentKey === null ? state : { ...state, currentKey: null };
    case "scanned": {
      const incoming = action.entry;
      const existing = state.entries.find((entry) => entry.key === incoming.key);
      if (!existing) {
        return { ...state, entries: [incoming, ...state.entries].slice(0, SHELF_MAX_ENTRIES), repeatKey: null };
      }
      // Same bottle again: keep its place and first-scan time, refresh what the new scan knows.
      return {
        ...replaceEntry(state, incoming.key, (entry) => ({
          ...entry,
          ...incoming,
          firstScannedAt: entry.firstScannedAt,
          lastScannedAt: incoming.lastScannedAt,
          scanCount: entry.scanCount + 1,
          acted: incoming.acted ?? entry.acted,
          dupe: incoming.dupe ?? entry.dupe,
        })),
        repeatKey: incoming.key,
      };
    }
    case "verdict_updated":
      return replaceEntry(state, action.key, (entry) => {
        const incoming = action.entry;
        // The chip keeps what the shelf showed when scanned, unless the scan only now found it.
        const next: ShelfEntry = {
          ...entry,
          verdict: entry.verdict === "not_found" ? incoming.verdict : entry.verdict,
          captureId: incoming.captureId ?? entry.captureId,
        };
        for (const field of ["shadeId", "display", "hex", "quantity", "brand", "shadeName"] as const) {
          if (incoming[field] !== undefined) (next as unknown as Record<string, unknown>)[field] = incoming[field];
        }
        if (incoming.acted) next.acted = incoming.acted;
        else if (action.clearActed) delete next.acted;
        return next;
      });
    case "acted":
      return replaceEntry(state, action.key, (entry) => {
        const next: ShelfEntry = { ...entry };
        if (action.acted) next.acted = action.acted;
        else delete next.acted;
        if (typeof action.quantity === "number") next.quantity = action.quantity;
        return next;
      });
    case "dupe_resolved":
      return replaceEntry(state, action.key, (entry) => {
        const next: ShelfEntry = { ...entry };
        if (action.dupe) {
          next.dupe = action.dupe;
          if (next.verdict === "new") next.verdict = "near_dupe";
        } else {
          delete next.dupe;
        }
        return next;
      });
    case "hydrated":
      return { ...EMPTY_SHELF, entries: action.entries.slice(0, SHELF_MAX_ENTRIES) };
    case "cleared":
      return EMPTY_SHELF;
    default:
      return state;
  }
}

/**
 * Where an entry stands now, after any action: an added entry counts as owned, a wishlisted one
 * as wishlist.
 */
export function shelfStatus(entry: Pick<ShelfEntry, "verdict" | "acted">): ShelfVerdict {
  if (entry.acted === "added" || entry.acted === "bought_another") return "owned";
  if (entry.acted === "wishlisted") return "wishlist";
  return entry.verdict;
}

export interface ShelfCounts {
  total: number;
  owned: number;
  wishlist: number;
  /** New to the user, near-dupes included. */
  new: number;
  nearDupe: number;
  notFound: number;
}

/** Counts strip: by what each entry was when scanned (the shelf as the shopper found it). */
export function shelfCounts(entries: readonly Pick<ShelfEntry, "verdict">[]): ShelfCounts {
  const counts: ShelfCounts = { total: entries.length, owned: 0, wishlist: 0, new: 0, nearDupe: 0, notFound: 0 };
  for (const entry of entries) {
    if (entry.verdict === "owned") counts.owned += 1;
    else if (entry.verdict === "wishlist") counts.wishlist += 1;
    else if (entry.verdict === "not_found") counts.notFound += 1;
    else {
      counts.new += 1;
      if (entry.verdict === "near_dupe") counts.nearDupe += 1;
    }
  }
  return counts;
}

export const SHELF_VERDICT_LABELS: Record<ShelfVerdict, string> = {
  owned: "Own it",
  wishlist: "Wishlist",
  near_dupe: "Near-dupe",
  new: "New",
  not_found: "Not found",
};

/** The quick actions an entry offers now. */
export type ShelfQuickAction = "add" | "wishlist" | "bought_another" | "manual";

export function shelfQuickActions(entry: Pick<ShelfEntry, "verdict" | "acted" | "shadeId" | "captureId">): ShelfQuickAction[] {
  const status = shelfStatus(entry);
  if (entry.verdict === "not_found") return ["manual"];
  if (status === "owned") return entry.shadeId ? ["bought_another"] : [];
  if (!entry.shadeId) return entry.captureId && !entry.acted ? ["add"] : [];
  if (status === "wishlist") return ["add"];
  return ["add", "wishlist"];
}

/** "just now", "2 min ago", "1 h ago" for the entry's time line. */
export function formatShelfAge(then: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.round(minutes / 60)} h ago`;
}

// ── sessionStorage ──────────────────────────────────────────────────────────────────────────

type ShelfStore = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

const VERDICTS = new Set<ShelfVerdict>(["owned", "wishlist", "near_dupe", "new", "not_found"]);
const ACTED = new Set<ShelfActed>(["added", "wishlisted", "bought_another"]);

function optionalString(value: unknown, max = 300): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, max) : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** One stored entry, or null when it is not a well-formed entry (dropped on read). */
function parseEntry(value: unknown): ShelfEntry | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const key = optionalString(raw.key);
  const verdict = raw.verdict as ShelfVerdict;
  const firstScannedAt = finiteNumber(raw.firstScannedAt);
  const lastScannedAt = finiteNumber(raw.lastScannedAt);
  if (!key || !VERDICTS.has(verdict) || firstScannedAt === undefined || lastScannedAt === undefined) return null;
  const entry: ShelfEntry = {
    key,
    captureId: optionalString(raw.captureId) ?? null,
    verdict,
    firstScannedAt,
    lastScannedAt,
    scanCount: Math.max(1, Math.floor(finiteNumber(raw.scanCount) ?? 1)),
  };
  for (const field of ["gtin", "format", "shadeId", "display", "brand", "shadeName"] as const) {
    const text = optionalString(raw[field]);
    if (text) entry[field] = text;
  }
  // Only a plain hex; anything else (e.g. a data URI) is never stored or read back.
  if (typeof raw.hex === "string" && /^#?[0-9a-f]{3,8}$/i.test(raw.hex)) entry.hex = raw.hex;
  const quantity = finiteNumber(raw.quantity);
  if (quantity !== undefined) entry.quantity = quantity;
  if (ACTED.has(raw.acted as ShelfActed)) entry.acted = raw.acted as ShelfActed;
  const dupe = raw.dupe as Record<string, unknown> | undefined;
  if (dupe && (dupe.grade === "high" || dupe.grade === "medium") && typeof dupe.name === "string") {
    entry.dupe = { grade: dupe.grade, name: dupe.name.slice(0, 300) };
  }
  return entry;
}

export function parseShelfEntries(raw: string | null): ShelfEntry[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(parseEntry)
      .filter((entry): entry is ShelfEntry => entry !== null)
      .slice(0, SHELF_MAX_ENTRIES);
  } catch {
    return [];
  }
}

/** Serialize through `parseEntry`'s allowlist so nothing but the known fields is ever stored. */
export function serializeShelfEntries(entries: readonly ShelfEntry[]): string {
  return JSON.stringify(entries.map((entry) => parseEntry(entry)).filter(Boolean));
}

export function safeShelfStorage(): ShelfStore | null {
  try {
    if (typeof window === "undefined") return null;
    return window.sessionStorage ?? null;
  } catch {
    return null;
  }
}

export function readShelf(storage: ShelfStore | null | undefined, key: string): ShelfEntry[] {
  if (!storage) return [];
  try {
    return parseShelfEntries(storage.getItem(key));
  } catch {
    return [];
  }
}

/** Save the shelf (an empty one removes the key). Storage failures are ignored. */
export function writeShelf(storage: ShelfStore | null | undefined, key: string, entries: readonly ShelfEntry[]): void {
  if (!storage) return;
  try {
    if (entries.length === 0) storage.removeItem(key);
    else storage.setItem(key, serializeShelfEntries(entries));
  } catch {
    // Quota or blocked storage: the shelf just doesn't survive a reload.
  }
}

/** Remove every user's shelf (sign-out). */
export function clearAllShelves(storage: ShelfStore | null | undefined): void {
  if (!storage) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key && (key === SHELF_STORAGE_PREFIX || key.startsWith(`${SHELF_STORAGE_PREFIX}:`))) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    // Blocked storage holds nothing to clear.
  }
}

// ── Telemetry ───────────────────────────────────────────────────────────────────────────────

/** `action` values of `rapid_add.shelf_action` (documented in docs/observability-plan.md). */
export type ShelfTelemetryAction = ShelfQuickAction | "clear" | "repeat_scan";

export const SHELF_ACTION_EVENT = "rapid_add.shelf_action";

export function shelfActionEvent(
  action: ShelfTelemetryAction,
  shelfSize: number,
  verdict?: ShelfVerdict,
): { name: typeof SHELF_ACTION_EVENT; properties: Record<string, string | number> } {
  return {
    name: SHELF_ACTION_EVENT,
    properties: { action, shelfSize, ...(verdict ? { verdict } : {}) },
  };
}
