/**
 * Rapid Add shelf mode for the native Add tab (web: `apps/web/src/lib/rapid-add-shelf.ts`, #426):
 * a running list of this shopper's verdicts, so a shelf of bottles can be checked one after
 * another and acted on afterwards. Same rules as the web: newest first, a second scan of the same
 * barcode is flagged in place ("Scanned already") instead of appended, entries hold only ids,
 * names, hexes and verdicts (never frame or image data), and nothing is added until a tap.
 *
 * The shelf is persisted per user through `api-cache` (`readCache` / `writeCache`, wiped on
 * sign-out with the rest of the cache). No React or network here.
 */
import type { RapidAddVerdict } from "./rapid-add";

export type ShelfVerdict = "owned" | "wishlist" | "near_dupe" | "new" | "not_found";

/** What the shopper did with an entry from Rapid Add. */
export type ShelfActed = "added" | "wishlisted" | "bought_another";

export interface ShelfEntry {
  /** `gtin:<code>` for barcode scans, `capture:<id>` otherwise. */
  key: string;
  gtin?: string;
  shadeId?: string;
  display?: string;
  hex?: string;
  verdict: ShelfVerdict;
  /** Bottles owned when known. */
  quantity?: number;
  /** "Brand Shade" of the best owned dupe (near-dupe entries). */
  dupeName?: string;
  acted?: ShelfActed;
  firstScannedAt: number;
  lastScannedAt: number;
  scanCount: number;
}

export interface ShelfState {
  entries: ShelfEntry[];
  /** Entry the latest scan matched an earlier one (the "Scanned already" flag). */
  repeatKey: string | null;
  /** Entry the scan in progress made; its later verdicts update it until `scan_ended`. */
  currentKey: string | null;
}

export const EMPTY_SHELF: ShelfState = { entries: [], repeatKey: null, currentKey: null };

export const SHELF_MAX_ENTRIES = 100;

/** `api-cache` key (scope = user id). */
export const SHELF_CACHE_KEY = "rapid-add-shelf";

export function shelfEntryKey(input: { gtin?: string | null; captureId?: string | null }): string | null {
  if (input.gtin) return `gtin:${input.gtin}`;
  if (input.captureId) return `capture:${input.captureId}`;
  return null;
}

/**
 * The entry for a checked verdict, or null when there is nothing to key it by or the verdict is
 * not a final answer (`pick` waits for the shopper's choice; `added` is recorded with `acted`).
 */
export function shelfEntryFromVerdict(
  verdict: RapidAddVerdict,
  context: { gtin?: string | null; captureId: string | null; now: number },
): ShelfEntry | null {
  let candidateVerdict: ShelfVerdict;
  switch (verdict.kind) {
    case "owned":
      candidateVerdict = "owned";
      break;
    case "wishlisted":
      candidateVerdict = "wishlist";
      break;
    case "near-dupe":
      candidateVerdict = "near_dupe";
      break;
    case "add":
      candidateVerdict = "new";
      break;
    case "not-found":
      candidateVerdict = "not_found";
      break;
    default:
      return null;
  }
  const gtin = verdict.kind === "not-found" ? (verdict.gtin ?? context.gtin) : context.gtin;
  const key = shelfEntryKey({ gtin, captureId: context.captureId });
  if (!key) return null;
  const entry: ShelfEntry = {
    key,
    verdict: candidateVerdict,
    firstScannedAt: context.now,
    lastScannedAt: context.now,
    scanCount: 1,
  };
  if (gtin) entry.gtin = gtin;
  if ("candidate" in verdict) {
    const { candidate } = verdict;
    entry.display = candidate.display;
    if (candidate.shadeId) entry.shadeId = candidate.shadeId;
    if (candidate.hex) entry.hex = candidate.hex;
  }
  if (verdict.kind === "owned") entry.quantity = verdict.quantity;
  if (verdict.kind === "near-dupe") {
    const best = verdict.dupes.dupes[0];
    if (best) entry.dupeName = [best.brand, best.name].filter(Boolean).join(" ");
  }
  return entry;
}

export type ShelfAction =
  /** A verdict of the scan in progress: updates its entry, or adds one for the first verdict. */
  | { type: "verdict"; entry: ShelfEntry }
  /** "Scan next": the next verdict starts a new entry. */
  | { type: "scan_ended" }
  | { type: "acted"; key: string; acted: ShelfActed | undefined; quantity?: number }
  | { type: "hydrated"; entries: ShelfEntry[] }
  | { type: "cleared" };

function replaceEntry(state: ShelfState, key: string, update: (entry: ShelfEntry) => ShelfEntry): ShelfState {
  const index = state.entries.findIndex((entry) => entry.key === key);
  if (index < 0) return state;
  const entries = state.entries.slice();
  entries[index] = update(entries[index]);
  return { ...state, entries };
}

export function shelfReducer(state: ShelfState, action: ShelfAction): ShelfState {
  switch (action.type) {
    case "verdict": {
      const incoming = action.entry;
      const hasCurrent = state.currentKey !== null && state.entries.some((e) => e.key === state.currentKey);
      if (hasCurrent) {
        // A later verdict of the same scan (a label photo after an unknown barcode, a picked
        // candidate) refines the entry the scan made, whatever key the new verdict would get.
        return replaceEntry(state, state.currentKey as string, (entry) => ({
          ...entry,
          verdict: incoming.verdict,
          display: incoming.display ?? entry.display,
          shadeId: incoming.shadeId ?? entry.shadeId,
          hex: incoming.hex ?? entry.hex,
          quantity: incoming.quantity ?? entry.quantity,
          dupeName: incoming.verdict === "near_dupe" ? incoming.dupeName : undefined,
          acted: undefined,
          lastScannedAt: incoming.lastScannedAt,
        }));
      }
      const existing = state.entries.find((e) => e.key === incoming.key);
      if (!existing) {
        return {
          entries: [incoming, ...state.entries].slice(0, SHELF_MAX_ENTRIES),
          repeatKey: null,
          currentKey: incoming.key,
        };
      }
      // Same bottle again: keep its place, first-scan time and what the shopper did with it.
      return {
        ...replaceEntry(state, incoming.key, (entry) => ({
          ...entry,
          ...incoming,
          firstScannedAt: entry.firstScannedAt,
          scanCount: entry.scanCount + 1,
          acted: entry.acted,
        })),
        repeatKey: incoming.key,
        currentKey: incoming.key,
      };
    }
    case "scan_ended":
      return state.currentKey === null ? state : { ...state, currentKey: null };
    case "acted":
      return replaceEntry(state, action.key, (entry) => {
        const next: ShelfEntry = { ...entry };
        if (action.acted) next.acted = action.acted;
        else delete next.acted;
        if (typeof action.quantity === "number") next.quantity = action.quantity;
        return next;
      });
    case "hydrated":
      return { ...EMPTY_SHELF, entries: action.entries.slice(0, SHELF_MAX_ENTRIES) };
    case "cleared":
      return EMPTY_SHELF;
  }
}

/** Where an entry stands now: an added entry counts as owned, a wishlisted one as wishlist. */
export function shelfStatus(entry: Pick<ShelfEntry, "verdict" | "acted">): ShelfVerdict {
  if (entry.acted === "added" || entry.acted === "bought_another") return "owned";
  if (entry.acted === "wishlisted") return "wishlist";
  return entry.verdict;
}

export interface ShelfCounts {
  total: number;
  owned: number;
  wishlist: number;
  /** New to the shopper, near-dupes included. */
  new: number;
  notFound: number;
}

/** Counts strip: by what each entry was when scanned (the shelf as the shopper found it). */
export function shelfCounts(entries: readonly Pick<ShelfEntry, "verdict">[]): ShelfCounts {
  const counts: ShelfCounts = { total: entries.length, owned: 0, wishlist: 0, new: 0, notFound: 0 };
  for (const entry of entries) {
    if (entry.verdict === "owned") counts.owned += 1;
    else if (entry.verdict === "wishlist") counts.wishlist += 1;
    else if (entry.verdict === "not_found") counts.notFound += 1;
    else counts.new += 1;
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

export type ShelfQuickAction = "add" | "wishlist" | "bought_another";

/** The quick actions an entry offers now (all need a catalog shade; not-found has none). */
export function shelfQuickActions(entry: Pick<ShelfEntry, "verdict" | "acted" | "shadeId">): ShelfQuickAction[] {
  if (!entry.shadeId || entry.verdict === "not_found") return [];
  const status = shelfStatus(entry);
  if (status === "owned") return ["bought_another"];
  if (status === "wishlist") return ["add"];
  return ["add", "wishlist"];
}

/** "just now", "2 min ago", "1 h ago". */
export function formatShelfAge(then: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.round(minutes / 60)} h ago`;
}

// ── persistence ─────────────────────────────────────────────────────────────────────────────

const VERDICTS = new Set<string>(["owned", "wishlist", "near_dupe", "new", "not_found"]);
const ACTED = new Set<string>(["added", "wishlisted", "bought_another"]);

function text(value: unknown, max = 300): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, max) : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** One stored entry through an allowlist, or null when malformed. Nothing else is ever stored. */
export function parseShelfEntry(value: unknown): ShelfEntry | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const key = text(raw.key);
  const first = num(raw.firstScannedAt);
  const last = num(raw.lastScannedAt);
  if (!key || typeof raw.verdict !== "string" || !VERDICTS.has(raw.verdict) || first === undefined || last === undefined) {
    return null;
  }
  const entry: ShelfEntry = {
    key,
    verdict: raw.verdict as ShelfVerdict,
    firstScannedAt: first,
    lastScannedAt: last,
    scanCount: Math.max(1, Math.floor(num(raw.scanCount) ?? 1)),
  };
  for (const field of ["gtin", "shadeId", "display", "dupeName"] as const) {
    const v = text(raw[field]);
    if (v) entry[field] = v;
  }
  if (typeof raw.hex === "string" && /^#?[0-9a-f]{3,8}$/i.test(raw.hex)) entry.hex = raw.hex;
  const quantity = num(raw.quantity);
  if (quantity !== undefined) entry.quantity = quantity;
  if (typeof raw.acted === "string" && ACTED.has(raw.acted)) entry.acted = raw.acted as ShelfActed;
  return entry;
}

export function parseShelfEntries(value: unknown): ShelfEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(parseShelfEntry)
    .filter((e): e is ShelfEntry => e !== null)
    .slice(0, SHELF_MAX_ENTRIES);
}

/** The payload to persist: run through the allowlist. */
export function shelfToStored(entries: readonly ShelfEntry[]): ShelfEntry[] {
  return parseShelfEntries(entries);
}
