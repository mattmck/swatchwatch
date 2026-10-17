"use client";

import { useCallback, useRef, useState } from "react";
import type { PolishDupeHint, PolishDupesResponse, PolishStatus } from "swatchwatch-shared";
import {
  ADD_GUARD_EVENTS,
  addGuardTelemetry,
  readSuppressedGuardKeys,
  resolveAddGuard,
  safeSessionStorage,
  suppressGuardKey,
  type AddGuardChoice,
  type AddGuardIntent,
  type AddGuardSurface,
} from "@/lib/add-guard";
import type { DupeVerdictKind } from "@/lib/dupes";
import { trackEvent } from "@/lib/telemetry";

/** One add/wishlist action to guard. */
export interface AddGuardRequest {
  /** `shadeGuardKey(id)` for an existing shade, `newShadeGuardKey(brand, name)` for a new one. */
  guardKey: string;
  /** "Brand Name", shown in the dialog. */
  shadeLabel: string;
  /** Current inventory status of the shade (null/undefined for a catalog-only or new shade). */
  status: PolishStatus | null | undefined;
  intent: AddGuardIntent;
  surface: AddGuardSurface;
  /** Batch hint already loaded on the page (`useDupeHints`); `best: null` skips the call. */
  hint?: PolishDupeHint | null;
  /** One dupe lookup, normally `() => getPolishDupes(id)`. Null = nothing to guard. */
  loadDupes: () => Promise<PolishDupesResponse | null>;
  /** Commit the add with the final intent (the original one, or `wishlist` for "wishlist instead"). */
  proceed: (intent: AddGuardIntent) => void | Promise<void>;
  /** The user cancelled in the dialog. */
  onCancel?: () => void;
}

/** A guard whose dialog is open (or queued behind another one). */
export interface ActiveAddGuard {
  request: AddGuardRequest;
  response: PolishDupesResponse;
  verdict: Exclude<DupeVerdictKind, "none">;
}

export interface AddGuardChoiceOptions {
  /** "Don't warn me for this shade again this session" was checked. */
  suppress: boolean;
  /** How the choice was made, e.g. `button`, `dismiss` (Esc / overlay / close), `dupe_link`. */
  via: string;
}

/**
 * Add guard (#266) for a page: call `guardAdd(request)` instead of adding directly, and render
 * `<AddGuardDialog guard={active} onChoice={choose} />`. The add proceeds immediately when there
 * is nothing to warn about, and also when the check fails or takes longer than
 * `ADD_GUARD_TIMEOUT_MS` (logged as `add_guard.check_failed`).
 */
export function useAddGuard() {
  const [queue, setQueue] = useState<ActiveAddGuard[]>([]);
  const [checking, setChecking] = useState<ReadonlySet<string>>(() => new Set());
  const inFlight = useRef(new Set<string>());

  const setCheckingKey = useCallback((key: string, on: boolean) => {
    setChecking((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const guardAdd = useCallback(
    async (request: AddGuardRequest): Promise<void> => {
      // A second click while the same shade is being checked is ignored, not added twice.
      if (inFlight.current.has(request.guardKey)) return;
      inFlight.current.add(request.guardKey);
      setCheckingKey(request.guardKey, true);

      let outcome: Awaited<ReturnType<typeof resolveAddGuard>>;
      try {
        outcome = await resolveAddGuard({
          status: request.status,
          intent: request.intent,
          guardKey: request.guardKey,
          suppressed: readSuppressedGuardKeys(safeSessionStorage()),
          hint: request.hint,
          loadDupes: request.loadDupes,
        });
      } finally {
        inFlight.current.delete(request.guardKey);
        setCheckingKey(request.guardKey, false);
      }

      if (outcome.kind === "warn") {
        trackEvent(
          ADD_GUARD_EVENTS.shown,
          addGuardTelemetry({ ...request, response: outcome.response })
        );
        setQueue((prev) => [...prev, { request, response: outcome.response, verdict: outcome.verdict }]);
        return;
      }

      if (outcome.kind === "proceed-unchecked") {
        trackEvent(ADD_GUARD_EVENTS.checkFailed, {
          ...addGuardTelemetry(request),
          reason: outcome.reason,
          error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
        });
      }
      await request.proceed(request.intent);
    },
    [setCheckingKey]
  );

  const active = queue[0] ?? null;

  const choose = useCallback(
    (choice: AddGuardChoice, options: AddGuardChoiceOptions) => {
      if (!active) return;
      setQueue((prev) => (prev[0] === active ? prev.slice(1) : prev.filter((entry) => entry !== active)));
      const { request, response } = active;
      if (options.suppress) suppressGuardKey(safeSessionStorage(), request.guardKey);
      trackEvent(ADD_GUARD_EVENTS.choice, {
        ...addGuardTelemetry({ ...request, response }),
        choice,
        via: options.via,
        suppressed: options.suppress,
      });
      if (choice === "added_anyway") void request.proceed(request.intent);
      else if (choice === "wishlisted_instead") void request.proceed("wishlist");
      else request.onCancel?.();
    },
    [active]
  );

  const isChecking = useCallback((guardKey: string) => checking.has(guardKey), [checking]);

  return { guardAdd, active, choose, isChecking };
}
