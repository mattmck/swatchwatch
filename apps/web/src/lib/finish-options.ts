import { FINISHES, finishLabel } from "@/lib/constants";

/** Minimal shape of a reference finish row needed for options/labels. */
export interface FinishTypeLike {
  name: string;
  displayName?: string | null;
}

/** One selectable finish (value = finish name sent to the API). */
export interface FinishOption {
  value: string;
  label: string;
}

/**
 * Build finish select/chip options from the reference `finish_type` rows. Every reference row is
 * included, including types added through the admin UI. Falls back to the built-in `FINISHES`
 * only when no reference rows are available.
 *
 * `extraValues` are finishes that must stay selectable even though they are not in the reference
 * list (for example a saved finish whose type was since removed); they are labeled with
 * `finishLabel` and de-duplicated case-insensitively. Options are sorted by label.
 */
export function buildFinishOptions(
  finishTypes: readonly FinishTypeLike[] | null | undefined,
  extraValues: readonly string[] = []
): FinishOption[] {
  const options: FinishOption[] = [];
  const seen = new Set<string>();
  const add = (value: string, label: string) => {
    const key = value.trim().toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    options.push({ value, label });
  };

  if (finishTypes && finishTypes.length > 0) {
    for (const finish of finishTypes) {
      add(finish.name, finish.displayName?.trim() || finishLabel(finish.name));
    }
  } else {
    for (const name of FINISHES) add(name, finishLabel(name));
  }
  for (const value of extraValues) add(value, finishLabel(value));

  return options.sort((a, b) => a.label.localeCompare(b.label));
}

/** Finish names to treat as "known" (e.g. for suggestions): reference rows, else built-ins. */
export function knownFinishNames(finishTypes: readonly FinishTypeLike[] | null | undefined): string[] {
  return buildFinishOptions(finishTypes).map((option) => option.value);
}

/** Display label for a finish name: the reference `displayName` when present, else `finishLabel`. */
export function resolveFinishLabel(name: string, finishTypes?: readonly FinishTypeLike[] | null): string {
  const key = name.trim().toLowerCase();
  if (!key) return "";
  const found = finishTypes?.find((finish) => finish.name.trim().toLowerCase() === key);
  return found?.displayName?.trim() || finishLabel(name);
}
