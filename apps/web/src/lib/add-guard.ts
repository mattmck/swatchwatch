import {
  DUPE_LIMITS,
  buildFinishFamilyMap,
  findDupes,
  prepareDupeCandidates,
  prepareDupeShade,
  type DupeShade,
  type FinishFamilySource,
  type Polish,
  type PolishDupeHint,
  type PolishDupesResponse,
  type PolishStatus,
} from "swatchwatch-shared";
import { dupeVerdict, type DupeVerdictKind } from "./dupes";
import type { DupeWarningOutcome } from "./metrics-events";

/**
 * Add guard (#266): before a shade is added to the collection or the wishlist, show the owned
 * near-dupes first so the user can cancel or wishlist instead of double-buying.
 *
 * Everything here is pure (the API call, storage and clock are injected) so the decision logic
 * is unit-tested; the React side is `useAddGuard` + `AddGuardDialog`.
 *
 * Flow: `addGuardPrecheck` (no network) → `resolveAddGuard` (one `GET /api/polishes/{id}/dupes`
 * call, bounded by `ADD_GUARD_TIMEOUT_MS`) → `warn` opens the dialog, anything else proceeds.
 * A failed or slow check never blocks the add.
 */

/** What the user was doing: adding to the collection, or adding to the wishlist. */
export type AddGuardIntent = "own" | "wishlist";

/** The user's answer in the dialog (telemetry value). */
export type AddGuardChoice = "cancelled" | "wishlisted_instead" | "added_anyway";

/** Where the guard ran (telemetry `page` value; the funnel `surface` comes from the intent). */
export type AddGuardSurface = "polishes-list" | "color-search" | "polish-form-create" | "polish-form-edit" | "looks";

/** Abandon the dupe check after this long and proceed with the add. */
export const ADD_GUARD_TIMEOUT_MS = 2000;

/** sessionStorage key holding the shade keys the user asked not to be warned about again. */
export const ADD_GUARD_SESSION_KEY = "swatchwatch.add-guard.suppressed";

/** Cap on remembered suppressions so the session entry cannot grow without bound. */
export const ADD_GUARD_MAX_SUPPRESSED = 200;

/**
 * Guard-only telemetry. The dialog itself reports the M2 funnel events `dupe.warning_shown` /
 * `dupe.warning_outcome` (`lib/metrics-events.ts`, roadmap §4).
 */
export const ADD_GUARD_EVENTS = {
  checkFailed: "add_guard.check_failed",
} as const;

/** Dialog choice → `dupe.warning_outcome` value. */
export const ADD_GUARD_OUTCOMES: Record<AddGuardChoice, DupeWarningOutcome> = {
  cancelled: "cancel",
  wishlisted_instead: "wishlist_instead",
  added_anyway: "add_anyway",
};

export type AddGuardSkipReason =
  /** The user already owns the shade: adding is a quantity increase, never a dupe. */
  | "already-owned"
  /** The shade already has the target status (wishlisting a wishlisted shade). */
  | "already-in-status"
  /** "Don't warn me for this shade again this session". */
  | "suppressed"
  /** A batch hint already loaded on the page says there is no owned dupe. */
  | "hint-none";

export type AddGuardPrecheck = { action: "skip"; reason: AddGuardSkipReason } | { action: "check" };

/**
 * Decide, without any network call, whether a guard check is needed.
 *
 * `hint` is the batch dupe hint for the shade when the page already has one (`useDupeHints`):
 * `best: null` means "no owned dupe" and skips the call; a hint with a dupe still needs the
 * full `GET /dupes` response for the dialog. `undefined` (no hint loaded) always checks.
 */
export function addGuardPrecheck(input: {
  status: PolishStatus | null | undefined;
  intent: AddGuardIntent;
  guardKey: string;
  suppressed: ReadonlySet<string>;
  hint?: PolishDupeHint | null;
}): AddGuardPrecheck {
  if (input.status === "owned") return { action: "skip", reason: "already-owned" };
  if (input.intent === "wishlist" && input.status === "wishlist") {
    return { action: "skip", reason: "already-in-status" };
  }
  if (input.suppressed.has(input.guardKey)) return { action: "skip", reason: "suppressed" };
  if (input.hint && input.hint.best === null) return { action: "skip", reason: "hint-none" };
  return { action: "check" };
}

export class AddGuardTimeoutError extends Error {
  constructor(ms: number) {
    super(`Dupe check timed out after ${ms}ms`);
    this.name = "AddGuardTimeoutError";
  }
}

/** Race `promise` against a timer; rejects with `AddGuardTimeoutError` when the timer wins. */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  timers: {
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
  } = {
    setTimeout: (fn, delay) => globalThis.setTimeout(fn, delay),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
  }
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const handle = timers.setTimeout(() => reject(new AddGuardTimeoutError(ms)), ms);
    promise.then(
      (value) => {
        timers.clearTimeout(handle);
        resolve(value);
      },
      (error: unknown) => {
        timers.clearTimeout(handle);
        reject(error);
      }
    );
  });
}

export type AddGuardOutcome =
  | { kind: "proceed"; reason: AddGuardSkipReason | "no-dupes" }
  /** The check failed or timed out: proceed with the add and log telemetry. */
  | { kind: "proceed-unchecked"; reason: "error" | "timeout"; error: unknown }
  | {
      kind: "warn";
      response: PolishDupesResponse;
      verdict: Exclude<DupeVerdictKind, "none">;
    };

/**
 * The full guard decision: precheck, then (when needed) one dupe call bounded by `timeoutMs`.
 * Never throws — errors and timeouts become `proceed-unchecked`.
 */
export async function resolveAddGuard(input: {
  status: PolishStatus | null | undefined;
  intent: AddGuardIntent;
  guardKey: string;
  suppressed: ReadonlySet<string>;
  hint?: PolishDupeHint | null;
  loadDupes: () => Promise<PolishDupesResponse | null>;
  timeoutMs?: number;
  timers?: Parameters<typeof withTimeout>[2];
}): Promise<AddGuardOutcome> {
  const precheck = addGuardPrecheck(input);
  if (precheck.action === "skip") return { kind: "proceed", reason: precheck.reason };

  let response: PolishDupesResponse | null;
  try {
    response = await withTimeout(
      Promise.resolve().then(input.loadDupes),
      input.timeoutMs ?? ADD_GUARD_TIMEOUT_MS,
      input.timers
    );
  } catch (error) {
    return {
      kind: "proceed-unchecked",
      reason: error instanceof AddGuardTimeoutError ? "timeout" : "error",
      error,
    };
  }

  // `null` = the loader decided there is nothing to guard (e.g. a new shade the user owns).
  if (!response) return { kind: "proceed", reason: "already-owned" };
  const verdict = dupeVerdict(response);
  if (verdict.kind === "none") return { kind: "proceed", reason: "no-dupes" };
  return { kind: "warn", response, verdict: verdict.kind };
}

// ── Session suppression ──────────────────────────────────────────────────────────────────────

type SessionStore = Pick<Storage, "getItem" | "setItem">;

/** `window.sessionStorage`, or null when unavailable (SSR, privacy mode, blocked storage). */
export function safeSessionStorage(): SessionStore | null {
  try {
    if (typeof window === "undefined") return null;
    return window.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** Shade keys the user silenced this session. Unreadable/corrupt storage reads as empty. */
export function readSuppressedGuardKeys(storage: SessionStore | null | undefined): Set<string> {
  if (!storage) return new Set();
  try {
    const raw = storage.getItem(ADD_GUARD_SESSION_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((value): value is string => typeof value === "string"));
  } catch {
    return new Set();
  }
}

/** Remember "don't warn me for this shade again this session". Storage failures are ignored. */
export function suppressGuardKey(storage: SessionStore | null | undefined, guardKey: string): void {
  if (!storage) return;
  try {
    const keys = Array.from(readSuppressedGuardKeys(storage)).filter((key) => key !== guardKey);
    keys.push(guardKey);
    storage.setItem(ADD_GUARD_SESSION_KEY, JSON.stringify(keys.slice(-ADD_GUARD_MAX_SUPPRESSED)));
  } catch {
    // Quota or blocked storage: the guard simply shows again next time.
  }
}

/** Suppression key for an existing shade. */
export function shadeGuardKey(shadeId: string | number): string {
  return `shade:${shadeId}`;
}

/** Suppression key for a brand-new shade (no id yet): brand + name, case-insensitive. */
export function newShadeGuardKey(brand: string, name: string): string {
  return `new:${normalizeName(brand)}|${normalizeName(name)}`;
}

function normalizeName(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

// ── Brand-new shades (/polishes/new) ─────────────────────────────────────────────────────────

/**
 * Dupes for a shade that does not exist yet, computed client-side from the entered hex and
 * finishes against the caller's owned shades (`GET /api/polishes?status=owned`) with the same
 * shared rule as the API (`prepareDupeShade` / `findDupes`). `options.finishTypes` are the reference
 * finish types (`useReferenceData`): their `family` grades admin-created finishes the way the API
 * does (#320); without them the built-in families apply. Returns null when the user already
 * owns a shade with the same brand and name (saving it is a quantity increase, not a dupe) or
 * when the entered hex is unusable.
 */
export function dupesForNewShade(
  shade: { brand: string; name: string; hex: string; finishes: readonly string[] },
  owned: readonly Polish[],
  options: { limit?: number; finishTypes?: readonly FinishFamilySource[] } = {}
): PolishDupesResponse | null {
  const limit = options.limit ?? DUPE_LIMITS.defaultLimit;
  const brand = normalizeName(shade.brand);
  const name = normalizeName(shade.name);
  const ownedPool = owned.filter((polish) => polish.status === "owned");
  if (
    brand &&
    name &&
    ownedPool.some((polish) => normalizeName(polish.brand) === brand && normalizeName(polish.name) === name)
  ) {
    return null;
  }

  const target = prepareDupeShade({
    shadeId: "new",
    brand: shade.brand,
    name: shade.name,
    vendorHex: shade.hex,
    finishes: [...shade.finishes],
  });
  if (!target) return null;

  const candidates = prepareDupeCandidates(
    ownedPool.map(
      (polish): DupeShade => ({
        shadeId: polish.id,
        brand: polish.brand,
        name: polish.name,
        vendorHex: polish.vendorHex,
        detectedHex: polish.detectedHex,
        nameHex: polish.nameHex,
        hexAgreement: polish.hexAgreement,
        finish: polish.finish,
        finishes: polish.finishes,
      })
    )
  );
  const { dupes, candidateCount } = findDupes(target, candidates, {
    finishFamilies: buildFinishFamilyMap(options.finishTypes),
  });
  return {
    target: {
      shadeId: target.shadeId,
      displayHex: target.displayHex,
      displayHexSource: target.displayHexSource,
      finishes: target.finishes,
    },
    dupes: dupes.slice(0, Math.max(1, limit)),
    dupeCount: dupes.length,
    highCount: dupes.filter((dupe) => dupe.grade === "high").length,
    candidateCount,
  };
}

// ── Telemetry ────────────────────────────────────────────────────────────────────────────────

/** Properties shared by the guard's telemetry events. No PII: shade ids are catalog ids. */
export function addGuardTelemetry(input: {
  surface: AddGuardSurface;
  intent: AddGuardIntent;
  guardKey: string;
  response?: PolishDupesResponse | null;
}): Record<string, string | number> {
  const props: Record<string, string | number> = {
    page: input.surface,
    intent: input.intent,
    shade: input.guardKey.startsWith("shade:") ? input.guardKey.slice("shade:".length) : "new",
  };
  if (input.response) {
    const verdict = dupeVerdict(input.response);
    props.verdict = verdict.kind;
    // `dupeCount` / `bestGrade` are set by the funnel event (`lib/metrics-events.ts`).
    props.highCount = input.response.highCount;
    if (verdict.best) {
      props.bestFinishCompatibility = verdict.best.finishCompatibility;
      props.bestDistance = verdict.best.distance;
    }
  }
  return props;
}

/** The PUT body for "Wishlist instead": status only, so an existing row keeps its quantity. */
export function wishlistInsteadUpdate(): { status: PolishStatus } {
  return { status: "wishlist" };
}
