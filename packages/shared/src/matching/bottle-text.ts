import { buildVendorCodeIndex, findPrintedGtins, findVendorCodeShades } from "./codes";
import { decideName, rankNames, type MatchListEntry, type NameDecisionOptions, type NameRank } from "./name-match";
import { buildTextPhrases, type RecognizedTextLine, type TextPhraseOptions } from "./text-lines";

export interface BottleTextCandidate {
  shadeId: number;
  name: string;
  /** 1 for a vendor-code hit, else the name similarity. */
  similarity: number;
  via: "code" | "name";
}

/**
 * How a `matched` result was decided. Only `exact` (a printed name equal, after normalisation,
 * to a name or alias of exactly one shade) is safe to add without confirmation. `lead` (the
 * closest name by edit similarity with a lead) cannot tell a misread from a real shade the list
 * lacks (63 same-brand near-twins in a leave-one-out over the catalog, e.g. Zoya Polly/Lolly),
 * and `code` (a printed vendor code) is dense: a misread code, or another printed number, is
 * often a sibling's code. Treat `lead` and `code` as "likely, needs a second signal".
 */
export type BottleTextRule = "exact" | "lead" | "code";

export type BottleTextResult =
  /** `code`: a vendor code printed on the bottle names exactly one shade (similarity and lead 1). */
  | { kind: "matched"; shadeId: number; via: "code" | "name"; rule: BottleTextRule; similarity: number; lead: number }
  /** Nothing is confident, or a code and a name disagree: let the user choose. */
  | { kind: "candidates"; ranked: BottleTextCandidate[] }
  | { kind: "none" };

export interface BottleTextOptions extends NameDecisionOptions {
  text?: TextPhraseOptions;
  /** Candidates must reach this name similarity. Default 0.6. */
  candidateMinSimilarity?: number;
  /** At most this many candidates. Default 5. */
  maxCandidates?: number;
}

export interface BottleTextMatch {
  result: BottleTextResult;
  /** Valid printed GTINs (12 or 13 digits, check digit ok) among the recognised tokens. */
  gtins: string[];
  /** Shade ids (ascending) of the list whose vendor code is printed on the bottle. */
  codeShadeIds: number[];
}

export interface BottleTextInput {
  /** Recognised lines of every photo (and rotation) of the bottle. */
  recognitions: ReadonlyArray<ReadonlyArray<RecognizedTextLine>>;
  /** The brand's shades (non-accessory) with their aliases. */
  entries: readonly MatchListEntry[];
  options?: BottleTextOptions;
}

const DEFAULT_CANDIDATE_MIN_SIMILARITY = 0.6;
const DEFAULT_MAX_CANDIDATES = 5;

/**
 * Identify a bottle from text printed on it, within one brand's shades. A vendor code that
 * names exactly one shade wins; otherwise the name decision (`decideName`). A code and a
 * confident name that point at different shades give candidates, never a match, and a name
 * that more than one shade carries gives every owner as a candidate.
 *
 * Only a `matched` result with `rule: "exact"` is safe to add without asking (see
 * {@link BottleTextRule}): `lead` and `code` mean "likely", and the caller should ask, or
 * confirm with a second independent signal (a measured color, another photo), before adding.
 */
export function matchBottleText(input: BottleTextInput): BottleTextMatch {
  const options = input.options ?? {};
  const { phrases, tokens } = buildTextPhrases(input.recognitions, options.text);
  const codeShadeIds = findVendorCodeShades(tokens, buildVendorCodeIndex(input.entries));
  const gtins = findPrintedGtins(tokens);
  const ranked = rankNames(phrases, input.entries, options);
  const decision = decideName(ranked, options);
  const nameOf = new Map<number, string>();
  for (const entry of input.entries) nameOf.set(entry.shadeId, entry.name);

  const candidates = (): BottleTextCandidate[] => {
    const out: BottleTextCandidate[] = [];
    const seen = new Set<number>();
    for (const shadeId of codeShadeIds) {
      seen.add(shadeId);
      out.push({ shadeId, name: nameOf.get(shadeId) ?? "", similarity: 1, via: "code" });
    }
    const floor = options.candidateMinSimilarity ?? DEFAULT_CANDIDATE_MIN_SIMILARITY;
    const rows: NameRank[] = ranked.filter((row) => row.similarity >= floor);
    for (const row of rows) {
      // Every owner of a shared name is a candidate.
      for (const shadeId of row.shadeIds ?? [row.shadeId]) {
        if (seen.has(shadeId)) continue;
        seen.add(shadeId);
        out.push({ shadeId, name: nameOf.get(shadeId) ?? row.name, similarity: row.similarity, via: "name" });
      }
    }
    return out.slice(0, options.maxCandidates ?? DEFAULT_MAX_CANDIDATES);
  };

  let result: BottleTextResult;
  if (codeShadeIds.length === 1) {
    const codeId = codeShadeIds[0];
    result =
      decision && decision.shadeId !== codeId
        ? { kind: "candidates", ranked: candidates() }
        : { kind: "matched", shadeId: codeId, via: "code", rule: "code", similarity: 1, lead: 1 };
  } else if (decision) {
    result =
      codeShadeIds.length > 1 && !codeShadeIds.includes(decision.shadeId)
        ? { kind: "candidates", ranked: candidates() }
        : {
            kind: "matched",
            shadeId: decision.shadeId,
            via: "name",
            rule: decision.rule,
            similarity: decision.similarity,
            lead: decision.lead,
          };
  } else {
    const list = candidates();
    result = list.length > 0 ? { kind: "candidates", ranked: list } : { kind: "none" };
  }
  return { result, gtins, codeShadeIds };
}
