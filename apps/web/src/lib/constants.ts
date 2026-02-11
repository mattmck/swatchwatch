/** Canonical list of nail polish finish types for UI dropdowns. */
export const FINISHES = [
  "cream",
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
  "other",
] as const;

const DEFAULT_FINISH_BADGE =
  "border border-brand-pink-soft/60 bg-brand-pink-soft/30 text-brand-ink";

const FINISH_BADGE_CLASS_MAP: Record<string, string> = {
  cream: "border border-rose-200 bg-rose-50 text-rose-900",
  shimmer: "border border-amber-200 bg-amber-50 text-amber-900",
  glitter: "border border-fuchsia-200 bg-fuchsia-50 text-fuchsia-900",
  metallic: "border border-slate-300 bg-slate-100 text-slate-800",
  matte: "border border-violet-200 bg-violet-50 text-violet-900",
  jelly: "border border-pink-200 bg-pink-50 text-pink-900",
  holographic: "border border-brand-lilac/60 bg-brand-pink-light/50 text-brand-purple-deep",
  duochrome: "border border-indigo-200 bg-indigo-50 text-indigo-900",
  multichrome: "border border-purple-200 bg-purple-50 text-purple-900",
  flake: "border border-cyan-200 bg-cyan-50 text-cyan-900",
  topper: "border border-brand-purple/30 bg-brand-lilac/35 text-brand-purple-deep",
  sheer: "border border-neutral-200 bg-neutral-50 text-neutral-800",
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
