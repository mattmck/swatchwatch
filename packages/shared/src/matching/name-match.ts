import { isVendorCodeAlias } from "./codes";
import { editSimilarity, normalizeMatchText } from "./normalize";

/**
 * Catalog names that are generic label text (normalised form). They are printed on every
 * bottle, so text alone can never identify a shade named like one of them.
 */
export const GENERIC_LABEL_NAMES: ReadonlySet<string> = new Set([
  "nailpolish",
  "naillacquer",
  "nailstrengthener",
  "topcoat",
  "basecoat",
  "nailcolor",
  "nailenamel",
  "lacquer",
  "polish",
  "gel",
  "mini",
  "shakewell",
  "shakewellbeforeuse",
]);

/** The numbers of the name decision, measured on the SwatchWatch bottle text eval. */
export const NAME_MATCH_RULES = {
  /** A shade matches only when its best phrase similarity is at least this. */
  minSimilarity: 0.8,
  /** ...and it leads the runner-up (another shade) by at least this much. */
  minLead: 0.25,
  /** A name matched exactly (similarity at least this) wins without a lead when the runner-up is below it. */
  exactSimilarity: 0.999,
  /** Names and phrases shorter than this (normalised) are never compared. */
  minChars: 3,
} as const;

/** One shade of a brand's match list. */
export interface MatchListEntry {
  shadeId: number;
  name: string;
  /**
   * Alias spellings. Vendor codes (see `isVendorCodeAlias`) are matched by equality in
   * `codes.ts`; every other alias (a retailer's listing title) counts as an extra name of the shade.
   */
  aliases?: readonly string[];
}

export interface NameRankOptions {
  /** Names and phrases shorter than this are skipped. Default {@link NAME_MATCH_RULES}.minChars. */
  minChars?: number;
  /** Normalised names that can never match. Default {@link GENERIC_LABEL_NAMES}. */
  stopNames?: ReadonlySet<string>;
}

/** The best phrase similarity of one distinct normalised catalog name. */
export interface NameRank {
  shadeId: number;
  /** The entry name or alias this row stands for, as given. */
  name: string;
  normalizedName: string;
  similarity: number;
}

/**
 * Rank a brand's names against the phrases read from the bottle: one row per distinct
 * normalised name (the first shade that has it), its best similarity over all phrases, sorted
 * by similarity descending (ties keep list order).
 */
export function rankNames(
  phrases: Iterable<string>,
  entries: readonly MatchListEntry[],
  options: NameRankOptions = {},
): NameRank[] {
  const minChars = options.minChars ?? NAME_MATCH_RULES.minChars;
  const stopNames = options.stopNames ?? GENERIC_LABEL_NAMES;
  const normalizedPhrases = new Set<string>();
  for (const phrase of phrases) {
    const key = normalizeMatchText(phrase);
    if (key.length >= minChars) normalizedPhrases.add(key);
  }
  const rows = new Map<string, NameRank>();
  const consider = (shadeId: number, name: string) => {
    const key = normalizeMatchText(name);
    if (key.length < minChars || stopNames.has(key) || rows.has(key)) return;
    let best = 0;
    for (const phrase of normalizedPhrases) {
      const score = editSimilarity(phrase, key);
      if (score > best) best = score;
    }
    rows.set(key, { shadeId, name, normalizedName: key, similarity: best });
  };
  for (const entry of entries) {
    consider(entry.shadeId, entry.name);
    for (const alias of entry.aliases ?? []) {
      if (!isVendorCodeAlias(alias)) consider(entry.shadeId, alias);
    }
  }
  return [...rows.values()]
    .map((row, index) => ({ row, index }))
    .sort((a, b) => b.row.similarity - a.row.similarity || a.index - b.index)
    .map((item) => item.row);
}

export interface NameDecisionOptions extends NameRankOptions {
  minSimilarity?: number;
  minLead?: number;
  exactSimilarity?: number;
  /** When false the exact-name shortcut is off and only the lead rule decides. Default true. */
  exactBeatsLead?: boolean;
}

export interface NameDecision {
  shadeId: number;
  name: string;
  similarity: number;
  /** Top similarity minus the best similarity of any other shade (the top one when there is none: 0). */
  lead: number;
  /** `exact`: matched by the exact-name shortcut; `lead`: matched by similarity and lead. */
  rule: "exact" | "lead";
}

/**
 * Decide from a ranking (see {@link rankNames}): an exact name (similarity at least
 * `exactSimilarity`) wins when the runner-up is below it, otherwise the top name needs
 * `minSimilarity` and a lead of `minLead` over the best other shade. Returns null when neither
 * holds. The runner-up is always a different shade, so a shade's own alias never costs it its lead.
 */
export function decideName(ranked: readonly NameRank[], options: NameDecisionOptions = {}): NameDecision | null {
  const top = ranked[0];
  if (!top) return null;
  const minSimilarity = options.minSimilarity ?? NAME_MATCH_RULES.minSimilarity;
  const minLead = options.minLead ?? NAME_MATCH_RULES.minLead;
  const exactSimilarity = options.exactSimilarity ?? NAME_MATCH_RULES.exactSimilarity;
  const exactBeatsLead = options.exactBeatsLead ?? true;
  const runnerUp = ranked.find((row) => row.shadeId !== top.shadeId);
  const second = runnerUp ? runnerUp.similarity : 0;
  const lead = top.similarity - second;
  if (exactBeatsLead && top.similarity >= exactSimilarity && second < exactSimilarity) {
    return { shadeId: top.shadeId, name: top.name, similarity: top.similarity, lead, rule: "exact" };
  }
  if (top.similarity >= minSimilarity && lead >= minLead) {
    return { shadeId: top.shadeId, name: top.name, similarity: top.similarity, lead, rule: "lead" };
  }
  return null;
}

/** {@link rankNames} then {@link decideName}. */
export function matchName(
  phrases: Iterable<string>,
  entries: readonly MatchListEntry[],
  options: NameDecisionOptions = {},
): NameDecision | null {
  return decideName(rankNames(phrases, entries, options), options);
}
