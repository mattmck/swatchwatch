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
  /**
   * When true (default) a read phrase that normalises to a stop name ("NAIL POLISH", "TOP COAT")
   * is not ranked: it is label text, and with the exact generic name out of the ranking it would
   * otherwise edit-match a near name ("Nail Police").
   */
  skipStopPhrases?: boolean;
  /**
   * The brand's own names (any spelling; normalised here), e.g. `["Starrily"]`. A read phrase for
   * which {@link isBrandText} is true for any of them is not ranked at all, even when it equals a
   * shade name exactly: the brand is printed on every bottle, and with "Starrily" misread as
   * "Starrly" a Starrily shade named "Stars" would otherwise win. A shade whose name is the brand
   * or a fragment of it cannot be identified by text alone; that is intended. Default: none, so
   * every phrase is ranked.
   */
  brandNames?: readonly string[];
}

/**
 * True when a read phrase is the brand's own text: the same name within a misread
 * (`editSimilarity` at least 0.75), or a truncated or split fragment of it (at least 3 characters,
 * shorter than the brand, and 0.8 similar to the brand's same-length prefix: "star", "starr" from
 * "Starrily"). Both arguments are already normalised with `normalizeMatchText`.
 */
export function isBrandText(phraseKey: string, brandKey: string): boolean {
  if (phraseKey.length === 0 || brandKey.length === 0) return false;
  if (editSimilarity(phraseKey, brandKey) >= 0.75) return true;
  return (
    phraseKey.length >= 3 &&
    phraseKey.length < brandKey.length &&
    editSimilarity(phraseKey, brandKey.slice(0, phraseKey.length)) >= 0.8
  );
}

/** The best phrase similarity of one distinct normalised catalog name. */
export interface NameRank {
  /** The first shade (list order) that carries this name. */
  shadeId: number;
  /**
   * Every shade that carries this normalised name as its name or a non-code alias, in list
   * order (`shadeIds[0] === shadeId`). More than one owner means the name does not say which
   * shade it is: {@link decideName} never decides it.
   */
  shadeIds: number[];
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
  const skipStopPhrases = options.skipStopPhrases ?? true;
  const brandKeys = (options.brandNames ?? []).map(normalizeMatchText).filter((key) => key.length > 0);
  const normalizedPhrases = new Set<string>();
  for (const phrase of phrases) {
    const key = normalizeMatchText(phrase);
    if (key.length < minChars || (skipStopPhrases && stopNames.has(key))) continue;
    if (brandKeys.some((brandKey) => isBrandText(key, brandKey))) continue;
    normalizedPhrases.add(key);
  }
  const rows = new Map<string, NameRank>();
  const consider = (shadeId: number, name: string) => {
    const key = normalizeMatchText(name);
    if (key.length < minChars || stopNames.has(key)) return;
    const existing = rows.get(key);
    if (existing) {
      if (!existing.shadeIds.includes(shadeId)) existing.shadeIds.push(shadeId);
      return;
    }
    let best = 0;
    for (const phrase of normalizedPhrases) {
      const score = editSimilarity(phrase, key);
      if (score > best) best = score;
    }
    rows.set(key, { shadeId, shadeIds: [shadeId], name, normalizedName: key, similarity: best });
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
  /**
   * `exact`: matched by the exact-name shortcut; `lead`: matched by similarity and lead.
   *
   * Only `exact` identifies a shade on its own. `lead` cannot tell a misread from a different
   * shade the list does not have: leave-one-out over the live catalog (2026-11-11) found 63
   * pairs where a real shade name one or two letters from another shade of the same brand
   * (Zoya Polly/Lolly, Bee's Knees Demon/Lemon, Cracked Polish Breezy/Freezy, OPI Less is
   * More/Less is Norse) decides that other shade by lead. Treat `lead` as "likely, needs a
   * second signal" (a color, another photo, the user).
   */
  rule: "exact" | "lead";
}

/**
 * Decide from a ranking (see {@link rankNames}): an exact name (similarity at least
 * `exactSimilarity`) wins when the runner-up is below it, otherwise the top name needs
 * `minSimilarity` and a lead of `minLead` over the best other shade. Returns null when neither
 * holds, or when the top name belongs to more than one shade (`shadeIds`). The runner-up is
 * always a different shade, so a shade's own alias never costs it its lead.
 */
export function decideName(ranked: readonly NameRank[], options: NameDecisionOptions = {}): NameDecision | null {
  const top = ranked[0];
  if (!top) return null;
  // A name two shades carry does not say which one it is.
  if ((top.shadeIds?.length ?? 1) > 1) return null;
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
