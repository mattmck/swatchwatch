/**
 * Catalog rows for `/polishes/search`: which target colors the page asks the API to rank
 * (`GET /api/polishes?nearHex=`), and a loader that keeps those rows current while the color
 * moves (wheel hover, lightness slider, swatch hover) without a request per mouse move.
 *
 * The page ranks every row it holds on the client (the whole owned collection plus these
 * catalog rows). The catalog part is only right when it was fetched for the colors the list is
 * ranked against, so the page shows the list as provisional until the rows for the current
 * targets have arrived.
 */

/** The API's `?nearHex=` cap. */
export const MAX_NEAR_HEX_TARGETS = 24;

export function uniqueHexes(hexes: readonly (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const hex of hexes) {
    if (!hex) continue;
    const canonical = hex.toUpperCase();
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    result.push(canonical);
  }
  return result;
}

export interface NearbyTargetsInput {
  /** Color under the wheel cursor (only the Similar list follows it). */
  hoverHex: string | null;
  selectedHex: string | null;
  /** Hovered or locked harmony swatch: the list is then ranked against it alone. */
  focusedTargetHex: string | null;
  similarMode: boolean;
  paletteAnchors: readonly string[];
  /**
   * Harmony targets of the selected color (or the active recommended palette's slots) before
   * they are snapped to polishes, so the query never depends on its own results.
   */
  rawHarmonyColors: readonly string[];
}

/** The colors the result list is ranked against, so its catalog rows are the nearest ones. */
export function listNearbyTargets(input: NearbyTargetsInput): string[] {
  if (input.focusedTargetHex) return uniqueHexes([input.focusedTargetHex]);
  if (input.similarMode) return uniqueHexes([input.hoverHex ?? input.selectedHex]);
  if (!input.selectedHex) return [];
  return uniqueHexes([input.selectedHex, ...input.rawHarmonyColors]).slice(0, MAX_NEAR_HEX_TARGETS);
}

/**
 * Every color the rest of the page matches against (Have / Buy for focused colors and palette
 * slots, "All" harmony snapping). Never the hover color: it changes on every mouse move.
 */
export function contextNearbyTargets(input: NearbyTargetsInput): string[] {
  return uniqueHexes([
    input.selectedHex,
    input.focusedTargetHex,
    ...input.paletteAnchors,
    ...input.rawHarmonyColors,
  ]).slice(0, MAX_NEAR_HEX_TARGETS);
}

export interface NearbyQuery {
  nearHex: string[];
  brand?: string;
  finish?: string;
}

/** One key per distinct query; `null` when there is nothing to ask for. */
export function nearbyQueryKey(query: NearbyQuery): string | null {
  if (query.nearHex.length === 0) return null;
  return JSON.stringify([query.nearHex, query.brand ?? null, query.finish ?? null]);
}

export interface LatestLoaderOptions<P, T> {
  load: (params: P, signal: AbortSignal) => Promise<T>;
  /** A response newer than every one applied so far; older responses are dropped. */
  onLoaded: (key: string, value: T) => void;
  onFailed?: (key: string, error: unknown) => void;
  /** At most one request starts per interval; the latest key is always fetched in the end. */
  minIntervalMs: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Throttled "latest wins" loader. While the key keeps changing it starts a request at most
 * every `minIntervalMs` (leading and trailing), so the rows follow a moving color instead of
 * waiting for it to stop. Responses apply in request order: a slow older response never
 * overwrites a newer one, and once a newer response lands the older requests are aborted.
 * At most one result is ever held by the caller, so nothing grows with the number of colors.
 */
export class LatestLoader<P, T> {
  private readonly options: LatestLoaderOptions<P, T>;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private wantedKey: string | null = null;
  private wantedParams: P | null = null;
  private lastStartedKey: string | null = null;
  private lastStartAt = Number.NEGATIVE_INFINITY;
  private timer: unknown = null;
  private seq = 0;
  private appliedSeq = 0;
  private readonly inFlight = new Map<number, AbortController>();
  private disposed = false;

  constructor(options: LatestLoaderOptions<P, T>) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** Ask for `key`; `null` cancels everything pending. */
  request(key: string | null, params: P): void {
    if (this.disposed || key === this.wantedKey) return;
    this.wantedKey = key;
    this.wantedParams = params;
    if (key === null) {
      this.cancelTimer();
      this.abortWhere(() => true);
      this.lastStartedKey = null;
      return;
    }
    if (key === this.lastStartedKey) {
      // Back to the request already running (or applied): nothing new to start.
      this.cancelTimer();
      return;
    }
    if (this.timer !== null) return; // the scheduled start picks up the latest key
    const delay = this.lastStartAt + this.options.minIntervalMs - this.now();
    if (delay <= 0) {
      this.start();
      return;
    }
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.start();
    }, delay);
  }

  dispose(): void {
    this.disposed = true;
    this.cancelTimer();
    this.abortWhere(() => true);
  }

  /** Requests started and not yet settled (for tests). */
  get pendingCount(): number {
    return this.inFlight.size;
  }

  private start(): void {
    const key = this.wantedKey;
    const params = this.wantedParams;
    if (this.disposed || key === null || params === null || key === this.lastStartedKey) return;
    const seq = ++this.seq;
    const controller = new AbortController();
    this.inFlight.set(seq, controller);
    this.lastStartedKey = key;
    this.lastStartAt = this.now();
    this.options.load(params, controller.signal).then(
      (value) => {
        this.inFlight.delete(seq);
        if (this.disposed || controller.signal.aborted || seq <= this.appliedSeq) return;
        this.appliedSeq = seq;
        this.abortWhere((other) => other < seq);
        this.options.onLoaded(key, value);
      },
      (error: unknown) => {
        this.inFlight.delete(seq);
        if (this.disposed || controller.signal.aborted || seq <= this.appliedSeq) return;
        // A failed request can be retried by asking for the same key again.
        if (this.lastStartedKey === key) this.lastStartedKey = null;
        if (this.wantedKey === key) this.wantedKey = null;
        this.options.onFailed?.(key, error);
      },
    );
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }

  private abortWhere(predicate: (seq: number) => boolean): void {
    for (const [seq, controller] of this.inFlight) {
      if (!predicate(seq)) continue;
      controller.abort();
      this.inFlight.delete(seq);
    }
  }
}
