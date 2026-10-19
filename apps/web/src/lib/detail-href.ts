/**
 * Links into `/polishes/detail` and the `returnTo` that brings the user back (#348, regression
 * of #87).
 *
 * Every detail link carries `returnTo` = the page it was clicked on (path + query), so the detail
 * page's back link returns to the same list page, filters, sort and selection. Pages whose state
 * lives in the URL pass their own canonical `returnTo` (the URL write lags one render behind
 * state); everything else uses the default, the current `window.location`.
 */

export const DEFAULT_RETURN_TO = "/polishes";

const SAFE_ORIGIN = "http://swatchwatch.invalid";
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * `value` when it is a same-origin relative path (`/…`, not `//…` or `/\…`), else `fallback`.
 * The value is used as is: `URLSearchParams.get` has already decoded it once.
 */
export function safeReturnTo(value: string | null | undefined, fallback: string = DEFAULT_RETURN_TO): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return fallback;
  if (CONTROL_CHARS.test(value)) return fallback;
  try {
    if (new URL(value, SAFE_ORIGIN).origin !== SAFE_ORIGIN) return fallback;
  } catch {
    return fallback;
  }
  return value;
}

/** The current path + query in the browser, or `undefined` while prerendering. */
export function currentReturnTo(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const { pathname, search } = window.location;
  return `${pathname}${search}`;
}

/**
 * `/polishes/detail?id=…&returnTo=…`. `returnTo` defaults to the current path + query; pass
 * `null` for no `returnTo`. Unsafe values are dropped (the detail page then falls back to
 * `/polishes`).
 */
export function detailHref(id: string, returnTo?: string | null): string {
  const base = `/polishes/detail?id=${encodeURIComponent(id)}`;
  const target = returnTo === undefined ? currentReturnTo() : returnTo;
  if (!target) return base;
  const safe = safeReturnTo(target, "");
  return safe ? `${base}&returnTo=${encodeURIComponent(safe)}` : base;
}

const RETURN_TO_LABELS: ReadonlyArray<readonly [string, string]> = [
  ["/polishes/gaps", "Gap Map"],
  ["/polishes/search", "Color search"],
  ["/polishes/match", "Photo Match"],
  ["/polishes/detail", "Previous polish"],
  ["/polishes", "Collection"],
  ["/dashboard", "Dashboard"],
  ["/manis", "Mani Log"],
  ["/rapid-add", "Rapid Add"],
];

/** Breadcrumb label for a (safe) `returnTo`, e.g. "Gap Map"; "Back" for pages not listed. */
export function returnToLabel(returnTo: string): string {
  const path = returnTo.split(/[?#]/, 1)[0].replace(/\/+$/, "") || "/";
  const match = RETURN_TO_LABELS.find(([prefix]) => path === prefix);
  return match ? match[1] : "Back";
}
