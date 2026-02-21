/**
 * @deprecated Fallback-only constant. Prefer API-backed finish types via useReferenceData().
 * Keep this list for resilience when reference endpoints are unavailable.
 */
export const FINISHES = [
  "creme",
  "shimmer",
  "glitter",
  "metallic",
  "matte",
  "jelly",
  "holographic",
  "duochrome",
  "multichrome",
  "flake",
  "topper",
  "sheer",
  "magnetic",
  "thermal",
  "glow",
  "crelly",
  "other",
] as const;

const DEFAULT_FINISH_BADGE =
  "border border-brand-pink-soft/60 bg-brand-pink-soft/30 text-brand-ink dark:border-brand-pink/40 dark:bg-brand-pink/10 dark:text-brand-pink-light";

const FINISH_BADGE_CLASS_MAP: Record<string, string> = {
  creme: "border border-rose-200 bg-rose-50 text-rose-900 dark:border-rose-800 dark:bg-rose-950/60 dark:text-rose-200",
  shimmer: "border border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-200",
  glitter: "border border-fuchsia-200 bg-fuchsia-50 text-fuchsia-900 dark:border-fuchsia-800 dark:bg-fuchsia-950/60 dark:text-fuchsia-200",
  metallic: "border border-slate-300 bg-slate-100 text-slate-800 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300",
  matte: "border border-violet-200 bg-violet-50 text-violet-900 dark:border-violet-800 dark:bg-violet-950/60 dark:text-violet-200",
  jelly: "border border-pink-200 bg-pink-50 text-pink-900 dark:border-pink-800 dark:bg-pink-950/60 dark:text-pink-200",
  holographic: "border border-brand-lilac/60 bg-brand-pink-light/50 text-brand-purple-deep dark:border-brand-lilac/40 dark:bg-brand-purple/20 dark:text-brand-pink",
  duochrome: "border border-indigo-200 bg-indigo-50 text-indigo-900 dark:border-indigo-800 dark:bg-indigo-950/60 dark:text-indigo-200",
  multichrome: "border border-purple-200 bg-purple-50 text-purple-900 dark:border-purple-800 dark:bg-purple-950/60 dark:text-purple-200",
  flake: "border border-cyan-200 bg-cyan-50 text-cyan-900 dark:border-cyan-800 dark:bg-cyan-950/60 dark:text-cyan-200",
  topper: "border border-brand-purple/30 bg-brand-lilac/35 text-brand-purple-deep dark:border-brand-purple/40 dark:bg-brand-lilac/20 dark:text-brand-pink",
  sheer: "border border-neutral-200 bg-neutral-50 text-neutral-800 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300",
  magnetic: "border border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-800 dark:bg-sky-950/60 dark:text-sky-200",
  thermal: "border border-orange-200 bg-orange-50 text-orange-900 dark:border-orange-800 dark:bg-orange-950/60 dark:text-orange-200",
  crelly: "border border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200",
  other: DEFAULT_FINISH_BADGE,
};

export function finishLabel(finish: string): string {
  if (!finish) return "";
  return finish.charAt(0).toUpperCase() + finish.slice(1);
}

export function finishBadgeClassName(finish?: string | null): string {
  if (!finish) return DEFAULT_FINISH_BADGE;
  return FINISH_BADGE_CLASS_MAP[finish] ?? DEFAULT_FINISH_BADGE;
}
