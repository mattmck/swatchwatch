/**
 * Text normalisation and edit distance for matching text printed on a bottle against catalog
 * names. Pure TypeScript with no Node or DOM APIs, so it runs on Hermes (no lookbehind, no
 * Unicode property escapes).
 */

/**
 * Collapse printed or catalog text to a comparison key: NFKD, lower-case, `&` → `and`,
 * `²` → `2`, `(R)` `(TM)` `(C)` and `® ™ ©` dropped, apostrophes dropped, and everything that is
 * not `a-z0-9` removed (so accents, spaces and punctuation never matter).
 */
export function normalizeMatchText(text: string): string {
  let s = (text ?? "").normalize("NFKD").toLowerCase().replace(/&/g, " and ").replace(/²/g, "2");
  s = s.replace(/\((?:r|tm|c)\)|[®™©]/g, "");
  s = s.replace(/[’'`]/g, "");
  return s.replace(/[^a-z0-9]+/g, "");
}

/** Levenshtein edit distance (insert, delete, substitute, each cost 1) between two strings. */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0 || b.length === 0) return Math.max(a.length, b.length);
  // A shared prefix and suffix never change the distance.
  let start = 0;
  let endA = a.length;
  let endB = b.length;
  while (start < endA && start < endB && a.charCodeAt(start) === b.charCodeAt(start)) start += 1;
  while (endA > start && endB > start && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) {
    endA -= 1;
    endB -= 1;
  }
  const lenA = endA - start;
  const lenB = endB - start;
  if (lenA === 0) return lenB;
  if (lenB === 0) return lenA;
  let prev = new Int32Array(lenB + 1);
  let cur = new Int32Array(lenB + 1);
  for (let j = 0; j <= lenB; j += 1) prev[j] = j;
  for (let i = 1; i <= lenA; i += 1) {
    cur[0] = i;
    const ca = a.charCodeAt(start + i - 1);
    for (let j = 1; j <= lenB; j += 1) {
      const cost = ca === b.charCodeAt(start + j - 1) ? 0 : 1;
      const del = prev[j] + 1;
      const ins = cur[j - 1] + 1;
      const sub = prev[j - 1] + cost;
      cur[j] = del < ins ? (del < sub ? del : sub) : ins < sub ? ins : sub;
    }
    const swap = prev;
    prev = cur;
    cur = swap;
  }
  return prev[lenB];
}

/**
 * `1 − distance / max(length)` of two already-normalised strings; `0` when either is empty.
 */
export function editSimilarity(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0;
  return 1 - levenshteinDistance(a, b) / Math.max(a.length, b.length);
}
